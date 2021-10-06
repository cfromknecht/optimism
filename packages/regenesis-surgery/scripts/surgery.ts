import { parseChunked } from '@discoveryjs/json-ext'
import { createReadStream } from 'fs'
import { ethers } from 'ethers'
import {
  StateDump,
  UniswapPoolData,
  SurgeryDataSources,
  EtherscanContract,
  SurgeryConfigs,
  StateDumpRoot,
} from './types'
import { loadConfigs, checkStateDumpRoot, readDumpFile } from './utils'
import { handlers } from './handlers'
import { classify } from './classifiers'

const main = async () => {
  const configs: SurgeryConfigs = loadConfigs()
  const stateDumpRoot: StateDumpRoot = await readDumpFile(
    configs.stateDumpFilePath
  )
  // TODO: maybe make this processStateDumpRoot and return
  // the list of accounts in StateDump type
  checkStateDumpRoot(stateDumpRoot)
  const dump: StateDump = null as any // TODO
  const genesis: StateDump = null as any // TODO
  const pools: UniswapPoolData[] = null as any // TODO
  const etherscanDump: EtherscanContract[] = await parseChunked(
    createReadStream(configs.etherscanFilePath)
  )
  const data: SurgeryDataSources = {
    dump,
    genesis,
    pools,
    etherscanDump,
    l1TestnetProvider: new ethers.providers.JsonRpcProvider(
      configs.l1TestnetProviderUrl
    ),
    l1MainnetProvider: new ethers.providers.JsonRpcProvider(
      configs.l1MainnetProviderUrl
    ),
    l2Provider: new ethers.providers.JsonRpcProvider(configs.l2ProviderUrl),
  }

  // TODO: Insert any accounts from genesis that aren't in the dump

  const output: StateDump = []
  for (const account of dump) {
    const accountType = classify(account, data)
    const handler = handlers[accountType]
    const newAccount = await handler(account, data)
    if (newAccount !== undefined) {
      output.push(newAccount)
    }
  }
}
