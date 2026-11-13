import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { loadDataset } from './dataset.js';
import { summarize } from './domain.js';
import { writeResult } from './output.js';
import { loadPolicy } from './policy.js';
import { discover } from './discover.js';
import { replayFrozen } from './replay.js';

const COMMANDS = ['summary', 'inspect', 'discover', 'replay'];
const OPTIONS = ['--input', '--out', '--policy', '--frozen'];

export function parseArguments(args) {
  const [command = 'summary', ...options] = args;
  if (!COMMANDS.includes(command)) throw new Error(`命令应为 ${COMMANDS.join('、')}`);
  const result = { command, input: 'data/records.json' };
  for (let index = 0; index < options.length; index += 2) {
    const name = options[index];
    const value = options[index + 1];
    if (!OPTIONS.includes(name) || !value || value.startsWith('--')) {
      throw new Error(`参数应为 ${OPTIONS.join('、')} 加路径`);
    }
    if (result[name.slice(2)] && name !== '--input') throw new Error('参数不可重复');
    result[name.slice(2)] = value;
  }
  if (command === 'discover' && !result.policy) result.policy = 'data/policy.json';
  if (command === 'replay' && !result.policy) result.policy = 'data/policy.json';
  if (command === 'replay' && !result.frozen) {
    throw new Error('replay 必须通过 --frozen 提供 discover 冻结的候选文件');
  }
  return result;
}

export async function main(args) {
  const options = parseArguments(args);
  const dataset = await loadDataset(options.input);
  let document;

  if (options.command === 'summary') {
    document = { ...summarize(dataset.records), inputFingerprint: dataset.fingerprint };
  } else if (options.command === 'inspect') {
    document = {
      records: dataset.records.length,
      fingerprint: dataset.fingerprint,
      fields: dataset.records.length ? Object.keys(dataset.records[0]).sort() : [],
      inputFingerprint: dataset.fingerprint,
    };
  } else if (options.command === 'discover') {
    const policy = await loadPolicy(options.policy);
    const result = discover(dataset.records, policy, policy.discoverPhase);
    document = {
      command: 'discover',
      generatedAt: new Date().toISOString(),
      input: resolve(options.input),
      policyPath: resolve(options.policy),
      policy,
      inputFingerprint: dataset.fingerprint,
      interpretation: {
        scope: '冻结候选仅描述发现场次上的访问路径与支持 visit 范围，signed 分组为事后描述',
        caution: '路径来自历史访问数据，不承诺因果提升；需经 replay 在独立场次复验后再考虑试行',
      },
      result,
    };
  } else {
    const policy = await loadPolicy(options.policy);
    const frozen = JSON.parse(await readFile(resolve(options.frozen), 'utf8'));
    if (typeof frozen.inputFingerprint !== 'string' || frozen.inputFingerprint.length === 0) {
      throw new Error('冻结文件缺少输入指纹，无法核验数据一致性，拒绝回放');
    }
    if (frozen.inputFingerprint !== dataset.fingerprint) {
      throw new Error('冻结文件的输入指纹与当前输入不一致，拒绝跨数据回放');
    }
    document = {
      ...replayFrozen(dataset.records, frozen, policy),
      generatedAt: new Date().toISOString(),
      input: resolve(options.input),
      policyPath: resolve(options.policy),
      frozenPath: resolve(options.frozen),
      policy,
      inputFingerprint: dataset.fingerprint,
    };
  }

  if (options.out) await writeResult(options.out, document);
  return document;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }).catch(error => {
    process.stderr.write(`处理失败：${error.message}\n`);
    process.exitCode = 1;
  });
}
