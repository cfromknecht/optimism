import { ethers } from 'ethers'
import * as fs from 'fs'
import byline from 'byline'
import * as dotenv from 'dotenv'
import * as assert from 'assert'

import { Account, StateDump, StateDumpRoot, SurgeryConfigs } from './types'

export const findAccount = (dump: StateDump, address: string): Account => {
  return dump.find((acc) => {
    return hexStringEqual(acc.address, address)
  })
}

export const hexStringEqual = (a: string, b: string): boolean => {
  if (!ethers.utils.isHexString(a)) {
    throw new Error(`not a hex string: ${a}`)
  }
  if (!ethers.utils.isHexString(b)) {
    throw new Error(`not a hex string: ${b}`)
  }

  return a.toLowerCase() === b.toLowerCase()
}

/**
 * Loads a variable from the environment and throws if the variable is not defined.
 *
 * @param name Name of the variable to load.
 * @returns Value of the variable as a string.
 */
export const reqenv = (name: string): any => {
  const value = process.env[name]
  if (value === undefined) {
    throw new Error(`missing env var ${name}`)
  }
  return value
}

export const loadConfigs = (): SurgeryConfigs => {
  dotenv.config()
  const stateDumpFilePath = reqenv('REGEN__STATE_DUMP_FILE')
  const etherscanFilePath = reqenv('REGEN__ETHERSCAN_FILE')
  const l2ProviderUrl = reqenv('REGEN__L2_PROVIDER_URL')
  const l2NetworkName = reqenv('REGEN__L2_NETWORK_NAME')
  const l1MainnetProviderUrl = reqenv('REGEN__L1_PROVIDER_URL')
  const l1TestnetProviderUrl = reqenv('REGEN__L1_TESTNET_PROVIDER_URL')
  const l1TestnetPrivateKey = reqenv('REGEN__L1_TESTNET_PRIVATE_KEY')

  // Input assertions
  assert.ok(
    ['mainnet', 'kovan'].includes(l2NetworkName),
    `L2_NETWORK_NAME must be one of "mainnet" or "kovan"`
  )

  return {
    stateDumpFilePath,
    etherscanFilePath,
    l2ProviderUrl,
    l2NetworkName,
    l1MainnetProviderUrl,
    l1TestnetProviderUrl,
    l1TestnetPrivateKey,
  }
}

/**
 * Reads the state dump file into an object. Required because the dumps get quite large.
 * JavaScript throws an error when trying to load large JSON files (>512mb) directly via
 * fs.readFileSync. Need a streaming approach instead.
 *
 * @param dumppath Path to the state dump file.
 * @returns Parsed state dump object.
 */
export const readDumpFile = async (
  dumppath: string
): Promise<StateDumpRoot> => {
  return new Promise<StateDumpRoot>((resolve) => {
    const dump: StateDumpRoot = {
      root: '',
      accounts: {},
    }

    const stream = byline(fs.createReadStream(dumppath, { encoding: 'utf8' }))

    let isFirstRow = true
    stream.on('data', (line: any) => {
      const data = JSON.parse(line)
      if (isFirstRow) {
        dump.root = data.root
        isFirstRow = false
      } else {
        const address = data.address
        delete data.address
        delete data.key
        dump.accounts[address] = data
      }
    })

    stream.on('end', () => {
      resolve(dump)
    })
  })
}

export const checkStateDumpRoot = (dump: StateDumpRoot) => {
  // Store a list of all addresses.
  const allAddresses = Object.keys(dump.accounts)

  // Sanity check to guarantee that all addresses in dump.accounts are lower case.
  console.log(`verifying that all contract addresses are lower case`)
  for (const [address, account] of Object.entries(dump.accounts)) {
    assert.equal(
      address.toLowerCase(),
      address,
      `unexpected upper case character in state dump address: ${address}`
    )

    assert.ok(
      typeof account.nonce === 'number',
      `nonce is not a number: ${account.nonce}`
    )

    assert.equal(
      account.codeHash.toLowerCase(),
      account.codeHash,
      `unexpected upper case character in state dump codeHash: ${account.codeHash}`
    )

    assert.equal(
      account.root.toLowerCase(),
      account.root,
      `unexpected upper case character in state dump root: ${account.root}`
    )

    if (account.code !== undefined) {
      assert.equal(
        account.code.toLowerCase(),
        account.code,
        `unexpected upper case character in state dump code: ${account.code}`
      )
    }

    // All accounts other than precompiles should have a balance of zero.
    if (!address.startsWith('0x00000000000000000000000000000000000000')) {
      assert.equal(
        account.balance,
        '0',
        `unexpected non-zero balance in state dump address: ${address}`
      )
    }

    if (account.storage !== undefined) {
      for (const [storageKey, storageVal] of Object.entries(account.storage)) {
        assert.equal(
          storageKey.toLowerCase(),
          storageKey,
          `unexpected upper case character in state dump storage key: ${storageKey}`
        )
        assert.equal(
          storageVal.toLowerCase(),
          storageVal,
          `unexpected upper case character in state dump storage value: ${storageVal}`
        )
      }
    }
  }
}
