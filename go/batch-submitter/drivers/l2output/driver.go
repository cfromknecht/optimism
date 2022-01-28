package l2output

import (
	"context"
	"crypto/ecdsa"
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum-optimism/optimism/go/batch-submitter/bindings/sro"
	"github.com/ethereum-optimism/optimism/go/batch-submitter/drivers"
	"github.com/ethereum-optimism/optimism/go/batch-submitter/metrics"
	"github.com/ethereum-optimism/optimism/go/batch-submitter/txmgr"
	l2ethclient "github.com/ethereum-optimism/optimism/l2geth/ethclient"
	"github.com/ethereum-optimism/optimism/l2geth/log"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
)

var bigOne = big.NewInt(1)

type Config struct {
	Name        string
	L1Client    *ethclient.Client
	L2Client    *l2ethclient.Client
	BlockOffset uint64
	MaxTxSize   uint64
	SROAddr     common.Address
	SCCAddr     common.Address
	ChainID     *big.Int
	PrivKey     *ecdsa.PrivateKey
}

type Driver struct {
	cfg            Config
	sroContract    *sro.StateRootOracle
	rawSroContract *bind.BoundContract
	walletAddr     common.Address
	metrics        *metrics.Metrics
}

func NewDriver(cfg Config) (*Driver, error) {
	sroContract, err := sro.NewStateRootOracle(
		cfg.SROAddr, cfg.L1Client,
	)
	if err != nil {
		return nil, err
	}

	parsed, err := abi.JSON(strings.NewReader(
		sro.StateRootOracleABI,
	))
	if err != nil {
		return nil, err
	}

	rawSroContract := bind.NewBoundContract(
		cfg.SROAddr, parsed, cfg.L1Client, cfg.L1Client, cfg.L1Client,
	)

	walletAddr := crypto.PubkeyToAddress(cfg.PrivKey.PublicKey)

	return &Driver{
		cfg:            cfg,
		sroContract:    sroContract,
		rawSroContract: rawSroContract,
		walletAddr:     walletAddr,
		metrics:        metrics.NewMetrics(cfg.Name),
	}, nil
}

// Name is an identifier used to prefix logs for a particular service.
func (d *Driver) Name() string {
	return d.cfg.Name
}

// WalletAddr is the wallet address used to pay for batch transaction fees.
func (d *Driver) WalletAddr() common.Address {
	return d.walletAddr
}

// Metrics returns the subservice telemetry object.
func (d *Driver) Metrics() *metrics.Metrics {
	return d.metrics
}

// ClearPendingTx a publishes a transaction at the next available nonce in order
// to clear any transactions in the mempool left over from a prior running
// instance of the batch submitter.
func (d *Driver) ClearPendingTx(
	ctx context.Context,
	txMgr txmgr.TxManager,
	l1Client *ethclient.Client,
) error {

	return drivers.ClearPendingTx(
		d.cfg.Name, ctx, txMgr, l1Client, d.walletAddr, d.cfg.PrivKey,
		d.cfg.ChainID,
	)
}

// GetBatchBlockRange returns the start and end L2 block heights that need to be
// processed. Note that the end value is *exclusive*, therefore if the returned
// values are identical nothing needs to be processed.
func (d *Driver) GetBatchBlockRange(
	ctx context.Context) (*big.Int, *big.Int, error) {

	callOpts := &bind.CallOpts{
		Pending: false,
		Context: ctx,
	}

	// Determine the next uncommitted L2 block number. We do so by transforming
	// the timestamp of the latest committed L2 block into its block number and
	// adding one.
	sroTimestamp, err := d.sroContract.LatestBlockTimestamp(callOpts)
	if err != nil {
		return nil, nil, err
	}
	start, err := d.sroContract.ComputeL2BlockNumber(callOpts, sroTimestamp)
	if err != nil {
		return nil, nil, err
	}
	start.Add(start, bigOne)

	// Next we need to obtain the current timestamp and the next timestamp at
	// which we will need to submit a state root. The former is done by simply
	// adding the submission interval to the latest committed block's timestamp;
	// the latter inspects the timestamp of the latest block.
	nextTimestamp, err := d.sroContract.NextTimestamp(callOpts)
	if err != nil {
		return nil, nil, err
	}
	latestHeader, err := d.cfg.L1Client.HeaderByNumber(ctx, nil)
	if err != nil {
		return nil, nil, err
	}
	currentTimestamp := big.NewInt(int64(latestHeader.Time))

	// If the submission window has yet to elapsed, we must wait before
	// submitting our L2 output commitment. Return start as the end value which
	// will signal that there is no work to be done.
	if currentTimestamp.Cmp(nextTimestamp) > 0 {
		return start, start, nil
	}

	// Otherwise the submission interval has elapsed. Transform the next
	// expected timestamp into its L2 block number, and add one since end is
	// exclusive.
	end, err := d.sroContract.ComputeL2BlockNumber(callOpts, nextTimestamp)
	if err != nil {
		return nil, nil, err
	}
	end.Add(end, bigOne)

	return start, end, nil
}

// CraftBatchTx transforms the L2 blocks between start and end into a batch
// transaction using the given nonce. A dummy gas price is used in the resulting
// transaction to use for size estimation.
//
// NOTE: This method SHOULD NOT publish the resulting transaction.
func (d *Driver) CraftBatchTx(
	ctx context.Context,
	start, end, nonce *big.Int,
) (*types.Transaction, error) {

	name := d.cfg.Name

	log.Info(name+" crafting batch tx", "start", start, "end", end,
		"nonce", nonce)

	// Fetch the final block in the range, as this is the only state root we
	// need to submit.
	nextCheckpointBlock := new(big.Int).Sub(end, bigOne)
	checkpointBlock, err := d.cfg.L2Client.HeaderByNumber(
		ctx, nextCheckpointBlock,
	)
	if err != nil {
		return nil, err
	}

	numElements := new(big.Int).Sub(start, end).Uint64()
	d.metrics.NumElementsPerBatch.Observe(float64(numElements))

	// Fetch the next expected timestamp that we will submit along with the
	// state root.
	callOpts := &bind.CallOpts{
		Pending: false,
		Context: ctx,
	}
	timestamp, err := d.sroContract.NextTimestamp(callOpts)
	if err != nil {
		return nil, err
	}

	// Sanity check that we are submitting against the same expected timestamp.
	expCheckpointBlock, err := d.sroContract.ComputeL2BlockNumber(
		callOpts, timestamp,
	)
	if err != nil {
		return nil, err
	}
	if nextCheckpointBlock.Cmp(expCheckpointBlock) != 0 {
		panic(fmt.Sprintf("next expected checkpoint block has changed, "+
			"want: %d, found: %d", nextCheckpointBlock.Uint64(),
			expCheckpointBlock.Uint64()))
	}

	log.Info(name+" batch constructed", "num_state_roots", numElements)

	opts, err := bind.NewKeyedTransactorWithChainID(
		d.cfg.PrivKey, d.cfg.ChainID,
	)
	if err != nil {
		return nil, err
	}
	opts.Context = ctx
	opts.Nonce = nonce
	opts.NoSend = true

	tx, err := d.sroContract.AppendStateRoot(
		opts, checkpointBlock.Root, timestamp,
	)
	switch {
	case err == nil:
		return tx, nil

	// If the transaction failed because the backend does not support
	// eth_maxPriorityFeePerGas, fallback to using the default constant.
	// Currently Alchemy is the only backend provider that exposes this method,
	// so in the event their API is unreachable we can fallback to a degraded
	// mode of operation. This also applies to our test environments, as hardhat
	// doesn't support the query either.
	case drivers.IsMaxPriorityFeePerGasNotFoundError(err):
		log.Warn(d.cfg.Name + " eth_maxPriorityFeePerGas is unsupported " +
			"by current backend, using fallback gasTipCap")
		opts.GasTipCap = drivers.FallbackGasTipCap
		return d.sroContract.AppendStateRoot(
			opts, checkpointBlock.Root, timestamp,
		)

	default:
		return nil, err
	}
}

// SubmitBatchTx using the passed transaction as a template, signs and
// publishes the transaction unmodified apart from sampling the current gas
// price. The final transaction is returned to the caller.
func (d *Driver) SubmitBatchTx(
	ctx context.Context,
	tx *types.Transaction,
) (*types.Transaction, error) {

	opts, err := bind.NewKeyedTransactorWithChainID(
		d.cfg.PrivKey, d.cfg.ChainID,
	)
	if err != nil {
		return nil, err
	}
	opts.Context = ctx
	opts.Nonce = new(big.Int).SetUint64(tx.Nonce())

	finalTx, err := d.rawSroContract.RawTransact(opts, tx.Data())
	switch {
	case err == nil:
		return finalTx, nil

	// If the transaction failed because the backend does not support
	// eth_maxPriorityFeePerGas, fallback to using the default constant.
	// Currently Alchemy is the only backend provider that exposes this method,
	// so in the event their API is unreachable we can fallback to a degraded
	// mode of operation. This also applies to our test environments, as hardhat
	// doesn't support the query either.
	case drivers.IsMaxPriorityFeePerGasNotFoundError(err):
		log.Warn(d.cfg.Name + " eth_maxPriorityFeePerGas is unsupported " +
			"by current backend, using fallback gasTipCap")
		opts.GasTipCap = drivers.FallbackGasTipCap
		return d.rawSroContract.RawTransact(opts, tx.Data())

	default:
		return nil, err
	}
}
