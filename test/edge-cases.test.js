import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVisits, findEmbeddings, matchVisits } from '../src/sequences.js';
import { discover, discoverFromVisits } from '../src/discover.js';
import { validatePolicy, DEFAULT_POLICY } from '../src/policy.js';

const base = { buyer: 'b', visit: 'v', tick: 0, zone: 'z', phase: 'early', signed: false, id: 'r' };
const makeVisits = rows => buildVisits(rows.map((patch, index) => ({ ...base, id: `r${index}`, ...patch })));
const policy = override => validatePolicy({ ...DEFAULT_POLICY, ...override });

test('间隔边界为闭区间：恰好等于 minGap 与 maxGap 都合法', () => {
  const visits = makeVisits([{ tick: 0, zone: 'a' }, { tick: 10, zone: 'b' }]);
  const atBoundary = { minGap: 10, maxGap: 10, maxSpan: 180 };
  assert.deepEqual(findEmbeddings(visits[0], [['a'], ['b']], atBoundary), [[0, 10]]);
  const justOutside = { minGap: 11, maxGap: 11, maxSpan: 180 };
  assert.deepEqual(findEmbeddings(visits[0], [['a'], ['b']], justOutside), []);
});

test('同刻重复 zone 与其他 zone 混合时只去重重复项，保留完整项集', () => {
  const visits = makeVisits([
    { tick: 0, zone: 'a' }, { tick: 0, zone: 'a' }, { tick: 0, zone: 'b' },
    { tick: 5, zone: 'c' }, { tick: 5, zone: 'c' },
  ]);
  assert.deepEqual(visits[0].steps, [
    { tick: 0, zones: ['a', 'b'] },
    { tick: 5, zones: ['c'] },
  ]);
  const matches = matchVisits(visits, [['a', 'b'], ['c']], { minGap: 0, maxGap: 60, maxSpan: 180 });
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0].matchTicks, [[0, 5]]);
});

test('maxSpan 与 maxGap 同时生效，任一违反都不产生匹配', () => {
  const visits = makeVisits([
    { tick: 0, zone: 'a' }, { tick: 50, zone: 'b' }, { tick: 120, zone: 'c' },
  ]);
  // 单步间隔都在 maxGap=60 内，但总跨度 120 超过 maxSpan=100。
  assert.deepEqual(
    findEmbeddings(visits[0], [['a'], ['b'], ['c']], { minGap: 0, maxGap: 60, maxSpan: 100 }),
    [],
  );
  // 放宽总跨度后恢复匹配。
  assert.equal(
    findEmbeddings(visits[0], [['a'], ['b'], ['c']], { minGap: 0, maxGap: 70, maxSpan: 120 }).length,
    1,
  );
});

test('发现场次没有 visit 时返回空结果而非伪造模式', () => {
  const records = [{ ...base, id: 'r1', phase: 'late', visit: 'v1', buyer: 'b1' }];
  const result = discover(records, policy(), 'early');
  assert.equal(result.visitCount, 0);
  assert.deepEqual(result.frozenPatterns, []);
  assert.equal(result.accounting.truncated, false);
  assert.equal(result.accounting.exploredCandidates, 0);
});

test('复验场次缺失由 replay 显式拒绝', async () => {
  const { replayFrozen } = await import('../src/replay.js');
  const records = [
    { ...base, id: 'r1', phase: 'early', visit: 'v1', buyer: 'b1', tick: 0, zone: 'a' },
    { ...base, id: 'r2', phase: 'early', visit: 'v1', buyer: 'b1', tick: 1, zone: 'b' },
  ];
  const activePolicy = policy();
  const frozen = {
    command: 'discover',
    inputFingerprint: (await import('../src/dataset.js')).recordsFingerprint(records),
    result: discover(records, activePolicy, 'early'),
  };
  assert.throws(() => replayFrozen(records, frozen, activePolicy), /late/);
});

test('同刻项集闭合：更具体的同刻超模式取代部分项集表示', () => {
  const rows = [];
  for (const visit of ['v1', 'v2', 'v3']) {
    rows.push(
      { visit, buyer: visit, tick: 0, zone: 'a' },
      { visit, buyer: visit, tick: 5, zone: 'b' },
      { visit, buyer: visit, tick: 5, zone: 'c' },
    );
  }
  const result = discoverFromVisits(makeVisits(rows), policy({ minSupport: 2, maxLength: 3 }));
  const closed = result.frozenPatterns.filter(item => item.closed).map(item => item.key).sort();
  // 唯一闭合项是完整的同刻序列 a>b&c；b&c 是它的子序列（支持集相同），同样不闭合。
  assert.deepEqual(closed, ['a>b&c']);
  // 部分项集 a>b 仍保留为可审计的非闭合候选。
  const partial = result.frozenPatterns.find(item => item.key === 'a>b');
  assert.equal(partial.closed, false);
});
