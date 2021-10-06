/* eslint @typescript-eslint/no-var-requires: "off" */
import { ethers } from 'ethers'
import path from 'path'
import solc from 'solc'
import { Account, StateDump, EtherscanContract } from './types'
import { LOCAL_SOLC_DIR } from './constants'

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

export const getSolc = (version: string, ovm?: boolean) => {
  if (ovm) {
    return solc.setupMethods(require(path.join(LOCAL_SOLC_DIR, version)))
  }
  return solc.setupMethods(
    require(path.join(LOCAL_SOLC_DIR, `solc-emscripten-wasm32-${version}.js`))
  )
}

export const solcInput = (contract: EtherscanContract) => {
  // Create a base solc input object
  const input = {
    language: 'Solidity',
    sources: {
      file: {
        // TODO: does this need the brackets?
        content: contract.sourceCode,
      },
    },
    settings: {
      outputSelection: {
        '*': {
          '*': ['*'],
        },
      },
      optimizer: {
        enabled: contract.optimizationUsed === '1',
        runs: parseInt(contract.runs, 10),
      },
    },
  }

  try {
    let sourceCode = contract.sourceCode
    // Remove brackets that are wrapped around the source
    // when trying to parse json
    if (sourceCode.substr(0, 2) === '{{') {
      // Trim the first and last bracket
      sourceCode = sourceCode.slice(1, -1)
    }
    // If the source code is valid json, and
    // has the keys of a solc input, just return it
    const json = JSON.parse(sourceCode)
    if (json.language) {
      return json
    }
    // Add the json file as the sources
    input.sources = json
  } catch (e) {
    console.error(`Unable to parse json ${contract.contractAddress}`)
  }
  return input
}
