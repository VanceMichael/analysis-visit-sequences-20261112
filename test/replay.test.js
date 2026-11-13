import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { discover } from '../src/discover.js';
import { replayFrozen } from '../src/replay.js';
import { buildVisits, findEmbeddings } from '../src/sequences.js';
import { validatePolicy, DEFAULT_POLICY } from '../src/policy.js';
import { recordsFingerprint } from '../src/dataset.js';

const datasetFingerprint = recordsFingerprint;

const base = { buyer: 'b', visit: 'v', tick: 0, zone: 'z', signed: false, id: 'r' };
const makeRecords = rows => rows.map((patch, index) => ({ ...base, id: `r${index}`, ...patch }));
const policy = override => validatePolicy({ ...DEFAULT_POLICY, ...override });

function splitDataset() {
  const rows = [];
  // 前半场（冻结）：a>b>c 出现在 4 个 early visit。
  for (let index = 0; index < 4; index += 1) {
    const visit = `e${index}`;
    rows.push(
      { visit, buyer: visit, phase: 'early', signed: index % 2 === 0, tick: 0, zone: 'a' },
      { visit, buyer: visit, phase: 'early', signed: index % 2 === 0, tick: 5, zone: 'b' },
      { visit, buyer: visit, phase: 'early', signed: index % 2 === 0, tick: 9, zone: 'c' },
    );
  }
  // 后半场（复验）：只有 1 个 late visit 重复该路径，低于 minSupport=2。
  rows.push(
    { visit: 'l0', buyer: 'l0', phase: 'late', signed: true, tick: 0, zone: 'a' },
    { visit: 'l0', buyer: 'l0', phase: 'late', signed: true, tick: 5, zone: 'b' },
    { visit: 'l0', buyer: 'l0', phase: 'late', signed: true, tick: 9, zone: 'c' },
    { visit: 'l1', buyer: 'l1', phase: 'late', signed: false, tick: 0, zone: 'a' },
    { visit: 'l1', buyer: 'l1', phase: 'late', signed: false, tick: 8, zone: 'x' },
  );
  return makeRecords(rows);
}

test('先冻结后复验：replay 只重放冻结模式，不重新发现，判定基于复验场次支持度', () => {
  const activePolicy = policy({ minSupport: 2, maxLength: 3, permutationTrials: 50 });
  const records = splitDataset();
  const frozenResult = discover(records, activePolicy, activePolicy.discoverPhase);
  const frozen = {
    command: 'discover',
    generatedAt: '2026-01-01T00:00:00.000Z',
    inputFingerprint: datasetFingerprint(records),
    result: frozenResult,
  };
  const replay = replayFrozen(records, frozen, activePolicy);
  assert.equal(replay.replay.phase, 'late');
  assert.equal(replay.replay.visitCount, 2);
  const target = replay.replay.patterns.find(item => item.key === 'a>b>c');
  assert.equal(target.discoverySupport, 4);
  assert.equal(target.replaySupport, 1);
  assert.equal(target.verdict, '复验未通过');
  // replay 不会产出冻结集之外的新模式。
  assert.deepEqual(
    replay.replay.patterns.map(item => item.key).sort(),
    frozenResult.frozenPatterns.map(item => item.key).sort(),
  );
  // 证据可展开到 visit 与匹配 tick。
  assert.deepEqual(target.evidence[0].matchTicks, [[0, 5, 9]]);
  assert.equal(target.evidence[0].visit, 'l0');
});

test('复验通过的路径同时给出适用 visit 范围与 signed 事后分组', () => {
  const activePolicy = policy({ minSupport: 2, maxLength: 3, permutationTrials: 20 });
  const rows = [];
  for (const visit of ['e0', 'e1']) {
    rows.push(
      { visit, buyer: visit, phase: 'early', signed: true, tick: 0, zone: 'a' },
      { visit, buyer: visit, phase: 'early', signed: true, tick: 5, zone: 'b' },
    );
  }
  for (const visit of ['l0', 'l1', 'l2']) {
    rows.push(
      { visit, buyer: visit, phase: 'late', signed: visit === 'l2', tick: 0, zone: 'a' },
      { visit, buyer: visit, phase: 'late', signed: visit === 'l2', tick: 5, zone: 'b' },
    );
  }
  const records = makeRecords(rows);
  const frozen = {
    command: 'discover',
    generatedAt: '2026-01-01T00:00:00.000Z',
    inputFingerprint: datasetFingerprint(records),
    result: discover(records, activePolicy, 'early'),
  };
  const replay = replayFrozen(records, frozen, activePolicy);
  const target = replay.replay.patterns.find(item => item.key === 'a>b');
  assert.equal(target.verdict, '复验通过');
  assert.equal(target.replaySupport, 3);
  assert.equal(target.groups.signedVisits, 1);
  assert.equal(target.groups.unsignedVisits, 2);
  assert.deepEqual(target.evidence.map(item => item.visit), ['l0', 'l1', 'l2']);
});

test('策略参数或输入指纹变化时拒绝回放，防止隐式重发现', () => {
  const records = splitDataset();
  const activePolicy = policy({ minSupport: 2, permutationTrials: 10 });
  const frozen = {
    command: 'discover',
    generatedAt: '2026-01-01T00:00:00.000Z',
    inputFingerprint: datasetFingerprint(records),
    result: discover(records, activePolicy, 'early'),
  };
  const changed = policy({ minSupport: 3, permutationTrials: 10 });
  assert.throws(() => replayFrozen(records, frozen, changed), /参数/);
  const wrongFingerprint = { ...frozen, inputFingerprint: '0'.repeat(64) };
  assert.throws(() => replayFrozen(records, wrongFingerprint, activePolicy), /指纹/);
  const missingFingerprint = { ...frozen };
  delete missingFingerprint.inputFingerprint;
  assert.throws(() => replayFrozen(records, missingFingerprint, activePolicy), /指纹/);
  assert.throws(() => replayFrozen(records, { command: 'summary' }, activePolicy), /discover/);
});

test('discover 与 replay 使用同一匹配语义：冻结证据与独立回放结果一致', () => {
  const activePolicy = policy({ minSupport: 2, maxLength: 3, permutationTrials: 10 });
  const records = splitDataset();
  const discovery = discover(records, activePolicy, 'early');
  const earlyVisits = buildVisits(records).filter(visit => visit.phase === 'early');
  for (const frozenPattern of discovery.frozenPatterns) {
    const discoveryVisitSet = new Set(frozenPattern.evidence.map(item => item.visit));
    const independent = new Set();
    for (const visit of earlyVisits) {
      if (findEmbeddings(visit, frozenPattern.pattern, {
        minGap: activePolicy.minGap, maxGap: activePolicy.maxGap, maxSpan: activePolicy.maxSpan,
      }).length > 0) independent.add(visit.visit);
    }
    assert.deepEqual(independent, discoveryVisitSet);
  }
});

test('CLI 端到端：discover 落盘冻结文件，replay 读取并复验，截断与基线字段齐备', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'freeze-'));
  try {
    const inputPath = join(folder, 'records.json');
    const policyPath = join(folder, 'policy.json');
    const frozenPath = join(folder, 'frozen.json');
    const replayPath = join(folder, 'replay.json');
    await writeFile(inputPath, JSON.stringify({ version: 1, records: splitDataset() }));
    const activePolicy = policy({ minSupport: 2, maxLength: 3, permutationTrials: 24 });
    await writeFile(policyPath, JSON.stringify(activePolicy));

    const discoverRun = spawnSync(process.execPath,
      ['src/cli.js', 'discover', '--input', inputPath, '--policy', policyPath, '--out', frozenPath],
      { encoding: 'utf8' });
    assert.equal(discoverRun.status, 0, discoverRun.stderr);
    const frozenDoc = JSON.parse(await readFile(frozenPath, 'utf8'));
    assert.equal(frozenDoc.command, 'discover');
    assert.ok(frozenDoc.result.accounting.exploredCandidates >= 1);
    assert.equal(typeof frozenDoc.result.accounting.truncated, 'boolean');

    const replayRun = spawnSync(process.execPath,
      ['src/cli.js', 'replay', '--input', inputPath, '--policy', policyPath,
        '--frozen', frozenPath, '--out', replayPath],
      { encoding: 'utf8' });
    assert.equal(replayRun.status, 0, replayRun.stderr);
    const replayDoc = JSON.parse(await readFile(replayPath, 'utf8'));
    assert.equal(replayDoc.command, 'replay');
    assert.equal(replayDoc.permutationBaseline.trials, 24);
    assert.equal(replayDoc.permutationBaseline.structureVerified, true);
    assert.ok(replayDoc.interpretation.caution.includes('因果'));

    // 缺少 --frozen 必须报错；未知命令返回非零退出码。
    assert.equal(spawnSync(process.execPath,
      ['src/cli.js', 'replay', '--input', inputPath, '--policy', policyPath]).status, 1);
    assert.equal(spawnSync(process.execPath, ['src/cli.js', 'frobnicate']).status, 1);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
