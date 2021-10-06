import { ethers } from 'ethers'
import linker from 'solc/linker'
import { KECCAK256_RLP_S, KECCAK256_NULL_S } from 'ethereumjs-util'
import { add0x } from '@eth-optimism/core-utils'
import { OLD_ETH_ADDRESS, COMPILER_VERSIONS_TO_SOLC } from './constants'
import {
  Account,
  AccountType,
  SurgeryDataSources,
  immutableReference,
  immutableReferences,
} from './types'
import { findAccount, solcInput, getSolc } from './utils'

export const handlers: {
  [key in AccountType]: (
    account: Account,
    data: SurgeryDataSources
  ) => Account | Promise<Account>
} = {
  [AccountType.EOA]: (account) => {
    return {
      address: account.address,
      nonce: account.nonce,
      balance: account.balance,
      codeHash: KECCAK256_NULL_S,
      root: KECCAK256_RLP_S,
    }
  },
  [AccountType.PRECOMPILE]: (account) => {
    return account
  },
  [AccountType.PREDEPLOY_DEAD]: () => {
    return undefined // delete the account
  },
  [AccountType.PREDEPLOY_WIPE]: (account, data) => {
    const genesisAccount = findAccount(data.genesis, account.address)
    return {
      ...account,
      code: genesisAccount.code,
      codeHash: genesisAccount.codeHash,
      storage: genesisAccount.storage,
    }
  },
  [AccountType.PREDEPLOY_NO_WIPE]: (account, data) => {
    const genesisAccount = findAccount(data.genesis, account.address)
    return {
      ...account,
      code: genesisAccount.code,
      codeHash: genesisAccount.codeHash,
      storage: {
        ...account.storage,
        ...genesisAccount.storage,
      },
    }
  },
  [AccountType.PREDEPLOY_ETH]: (account, data) => {
    const genesisAccount = findAccount(data.genesis, account.address)
    const oldEthAccount = findAccount(data.dump, OLD_ETH_ADDRESS)
    return {
      ...account,
      code: genesisAccount.code,
      codeHash: genesisAccount.codeHash,
      storage: {
        ...oldEthAccount.storage,
        ...genesisAccount.storage,
      },
    }
  },
  [AccountType.PREDEPLOY_WETH]: (account, data) => {
    // TODO
    throw new Error('Not implemented')
  },
  [AccountType.UNISWAP_V3_FACTORY]: () => {
    // TODO
    // Transfer the owner slot
    // Transfer the feeAmountTickSpacing slot
    // Transfer the getPool slot
    throw new Error('Not implemented')
  },
  [AccountType.UNISWAP_V3_NFPM]: () => {
    // TODO
    // Transfer the _poolIds slot
    throw new Error('Not implemented')
  },
  [AccountType.UNISWAP_V3_POOL]: async (account, data) => {
    const poolData = data.pools.find((pool) => {
      return pool.oldAddress === account.address
    })
    const poolCode = await data.l1TestnetProvider.getCode(poolData.newAddress)
    return {
      ...account,
      address: poolData.newAddress,
      code: poolCode,
      codeHash: ethers.utils.keccak256(poolCode),
    }
  },
  [AccountType.UNISWAP_V3_LIB]: () => {
    return undefined // delete the account
  },
  [AccountType.UNISWAP_V3_OTHER]: async (account, data) => {
    const code = await data.l1MainnetProvider.getCode(account.address)
    return {
      ...account,
      code,
      codeHash: ethers.utils.keccak256(code),
    }
  },
  [AccountType.UNVERIFIED]: () => {
    return undefined // delete the account
  },
  [AccountType.VERIFIED]: (account: Account, data: SurgeryDataSources) => {
    // Make a copy of the account to not mutate it
    account = { ...account }
    // Find the account in the etherscan dump
    const contract = data.etherscanDump.find(
      (c) => c.contractAddress === account.address
    )
    // The contract must exist
    if (!contract) {
      throw new Error(`Unable to find ${account.address} in etherscan dump`)
    }
    // Create the solc input object
    const input = solcInput(contract)
    const version = COMPILER_VERSIONS_TO_SOLC[contract.compilerVersion]
    if (!version) {
      throw new Error(`Unable to find solc version ${contract.compilerVersion}`)
    }

    // Get a solc compiler
    const currSolc = getSolc(version)
    // Compile the contract
    const output = JSON.parse(currSolc.compile(JSON.stringify(input)))
    if (!output.contracts) {
      throw new Error(`Cannot compile ${contract.contractAddress}`)
    }

    // TODO: How can we make sure this is correct?
    // Contract name does not correspond with what's compiled from Etherscan sourcecode
    let mainOutput
    // there's a name for this multi-file address
    if (contract.contractFileName) {
      mainOutput =
        output.contracts[contract.contractFileName][contract.contractName]
    } else {
      mainOutput = output.contracts.file[contract.contractName]
    }
    if (!mainOutput) {
      throw new Error(`Contract filename mismatch: ${contract.contractAddress}`)
    }

    account.code = mainOutput.evm.deployedBytecode.object
    account.codeHash = ethers.utils.keccak256(add0x(account.code))

    // Find the immutables in the old code and move them to the new
    const immutableRefs: immutableReference =
      mainOutput.evm.deployedBytecode.immutableReferences
    if (immutableRefs && Object.keys(immutableRefs).length !== 0) {
      // Compile using the ovm compiler to find the location of the
      // immutableRefs in the ovm contract so they can be migrated
      // to the new contract
      const ovmSolc = getSolc(contract.compilerVersion)
      const ovmOutput = JSON.parse(ovmSolc.compile(JSON.stringify(input)))
      let ovmFile
      if (contract.contractFileName) {
        ovmFile =
          ovmOutput.contracts[contract.contractFileName][contract.contractName]
      } else {
        ovmFile = ovmOutput.contracts.file[contract.contractName]
      }

      const ovmImmutableRefs: immutableReference =
        ovmFile.evm.deployedBytecode.immutableReferences

      let ovmObject = ovmFile.evm.deployedBytecode
      if (typeof ovmObject === 'object') {
        ovmObject = ovmObject.object
      }

      // Iterate over the immutableRefs and slice them into the new code
      // to carry over their values. The keys are the AST IDs
      for (const [key, value] of Object.entries(immutableRefs)) {
        const ovmValue = ovmImmutableRefs[key]
        if (!ovmValue) {
          throw new Error(`cannot find ast in ovm compiler output`)
        }
        // Each value is an array of {length, start}
        for (const [i, ref] of value.entries()) {
          const ovmRef = ovmValue[i]
          if (ref.length !== ovmRef.length) {
            throw new Error(`length mismatch`)
          }

          // Get the value from the contract code
          const immutable = ovmObject.slice(
            ovmRef.start,
            ovmRef.start + ovmRef.length
          )

          let object = mainOutput.evm.deployedBytecode
          if (object === undefined) {
            throw new Error(`deployedBytecode undefined`)
          }
          // Sometimes the shape of the output is different?
          if (typeof object === 'object') {
            object = object.object
          }

          const pre = object.slice(0, ref.start)
          const post = object.slice(ref.start + ref.length)
          const bytecode = pre + immutable + post

          if (bytecode.length !== object.length) {
            throw new Error(
              `mismatch in size: ${bytecode.length} vs ${object.length}`
            )
          }

          account.code = bytecode
          account.codeHash = ethers.utils.keccak256(bytecode)
        }
      }
    }

    // TODO: handle libraries
    return account
  }
}
