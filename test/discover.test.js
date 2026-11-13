import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverFromVisits } from '../src/discover.js';
import { buildVisits } from '../src/sequences.js';
import { validatePolicy, DEFAULT_POLICY } from '../src/policy.js';

const base = { buyer: 'b', visit: 'v', tick: 0, zone: 'z', phase: 'early', signed: false, id: 'r' };
const makeVisits = rows => buildVisits(rows.map((patch, index) => ({ ...base, id: `r${index}`, ...patch })));
const policy = override => validatePolicy({ ...DEFAULT_POLICY, ...override });

test('带 maxGap 约束时不依赖支持度反单调剪枝，频繁超模式不会因子模式不频繁而被漏掉', () => {
  // 构造：a>b 这条两步模式只在紧凑窗口（间隔 5）内出现于 3 个 visit；
  // 单步 a 本身在更多位置出现，且有一个远离窗口的 b 会让宽松匹配与紧凑匹配分离。
  // 关键是 a>b 在 minSupport=3 下频繁，而任何 Apriori 式提前剪枝都不应跳过它。
  const rows = [];
  for (const visitId of ['v1', 'v2', 'v3']) {
    rows.push({ visit: visitId, buyer: visitId, tick: 0, zone: 'a' });
    rows.push({ visit: visitId, buyer: visitId, tick: 5, zone: 'b' });
    rows.push({ visit: visitId, buyer: visitId, tick: 50, zone: 'q' });
  }
  // 干扰 visit：含 a 但 b 落在窗口外，a>b 不匹配，证明窗口约束真实生效。
  rows.push({ visit: 'v4', buyer: 'b4', tick: 0, zone: 'a' });
  rows.push({ visit: 'v4', buyer: 'b4', tick: 40, zone: 'b' });

  const result = discoverFromVisits(makeVisits(rows), policy({ minSupport: 3, maxGap: 10, maxLength: 2, candidateLimit: 500 }));
  const keys = result.frozenPatterns.map(item => item.key);
  assert.ok(keys.includes('a>b'), '紧凑窗口内的频繁超模式必须被发现');
  const found = result.frozenPatterns.find(item => item.key === 'a>b');
  assert.equal(found.supportVisits, 3);
  assert.equal(result.accounting.truncated, false);
});

test('maxSpan 跨窗口模式按总跨度过滤，但可行模式完整保留', () => {
  const rows = [
    { visit: 'v1', buyer: 'b1', tick: 0, zone: 'a' },
    { visit: 'v1', buyer: 'b1', tick: 10, zone: 'b' },
    { visit: 'v1', buyer: 'b1', tick: 25, zone: 'c' },
    { visit: 'v2', buyer: 'b2', tick: 0, zone: 'a' },
    { visit: 'v2', buyer: 'b2', tick: 10, zone: 'b' },
    { visit: 'v2', buyer: 'b2', tick: 25, zone: 'c' },
  ];
  const tight = discoverFromVisits(makeVisits(rows), policy({ minSupport: 2, maxGap: 24, maxSpan: 24, maxLength: 3 }));
  assert.equal(tight.frozenPatterns.some(item => item.key === 'a>b>c'), false);
  const loose = discoverFromVisits(makeVisits(rows), policy({ minSupport: 2, maxGap: 25, maxSpan: 25, maxLength: 3 }));
  assert.ok(loose.frozenPatterns.some(item => item.key === 'a>b>c'));
});

test('候选上限触发时明示截断，不把没搜完表述为没有其他模式', () => {
  const zones = ['a', 'b', 'c', 'd', 'e'];
  const rows = [];
  for (let visitIndex = 0; visitIndex < 3; visitIndex += 1) {
    zones.forEach((zone, tick) => rows.push({
      visit: `v${visitIndex}`, buyer: `b${visitIndex}`, tick: tick * 5, zone,
    }));
  }
  const result = discoverFromVisits(makeVisits(rows), policy({ minSupport: 2, maxLength: 4, candidateLimit: 5 }));
  assert.equal(result.accounting.truncated, true);
  assert.ok(result.accounting.truncationReason.includes('candidateLimit'));
  assert.ok(result.accounting.closureScope.includes('截断'));
  // 已评估候选数不得超过上限，且截断点说明停在哪一层。
  assert.ok(result.accounting.exploredCandidates <= 5);
  assert.ok(result.accounting.truncationPoint.includes('层'));
});

test('候选上限只约束已评估候选数，可枚举数低于上限时不得误报截断', () => {
  // 3 个 visit、5 个 zone 的小规模数据，全部可行候选远少于 2000，必须穷尽且不截断。
  const zones = ['a', 'b', 'c', 'd', 'e'];
  const rows = [];
  for (let visitIndex = 0; visitIndex < 3; visitIndex += 1) {
    zones.forEach((zone, tick) => rows.push({
      visit: `v${visitIndex}`, buyer: `b${visitIndex}`, tick: tick * 5, zone,
    }));
  }
  const result = discoverFromVisits(makeVisits(rows), policy({ minSupport: 2, maxLength: 4, candidateLimit: 2000 }));
  assert.equal(result.accounting.truncated, false);
  assert.equal(result.accounting.closureScope, '覆盖全部可行候选');
  // 已评估数等于入队数，没有遗留未评估候选。
  assert.equal(result.accounting.exploredCandidates, result.accounting.enqueuedCandidates);
});

test('未触顶时截断标记为假，且输出为闭合序列表示', () => {
  const rows = [
    { visit: 'v1', buyer: 'b1', tick: 0, zone: 'a' }, { visit: 'v1', buyer: 'b1', tick: 1, zone: 'b' },
    { visit: 'v2', buyer: 'b2', tick: 0, zone: 'a' }, { visit: 'v2', buyer: 'b2', tick: 1, zone: 'b' },
  ];
  const result = discoverFromVisits(makeVisits(rows), policy({ minSupport: 2, maxLength: 2 }));
  assert.equal(result.accounting.truncated, false);
  // a 与 a>b 支持集相同，只有 a>b 闭合。
  const closedKeys = result.frozenPatterns.filter(item => item.closed).map(item => item.key);
  assert.deepEqual(closedKeys, ['a>b']);
});

test('同刻项集被当作无序一步发现，同刻 zone 不产生有序两步模式', () => {
  const rows = [];
  for (const visitId of ['v1', 'v2']) {
    rows.push({ visit: visitId, buyer: visitId, tick: 0, zone: 'a' });
    rows.push({ visit: visitId, buyer: visitId, tick: 10, zone: 'b' });
    rows.push({ visit: visitId, buyer: visitId, tick: 10, zone: 'c' });
  }
  const result = discoverFromVisits(makeVisits(rows), policy({ minSupport: 2, maxLength: 3 }));
  const keys = result.frozenPatterns.map(item => item.key);
  assert.ok(keys.includes('a>b&c'), '同刻 b、c 以项集步骤表示');
  assert.equal(keys.includes('b>c'), false);
  assert.equal(keys.includes('c>b'), false);
  const itemsetPattern = result.frozenPatterns.find(item => item.key === 'a>b&c');
  assert.deepEqual(itemsetPattern.pattern, [['a'], ['b', 'c']]);
});

test('候选核算覆盖枚举、剪枝、支持度与闭合各阶段，数字守恒', () => {
  const rows = [
    { visit: 'v1', buyer: 'b1', tick: 0, zone: 'a' }, { visit: 'v1', buyer: 'b1', tick: 1, zone: 'b' },
    { visit: 'v2', buyer: 'b2', tick: 0, zone: 'a' },
  ];
  const result = discoverFromVisits(makeVisits(rows), policy({ minSupport: 2, maxLength: 2 }));
  const accounting = result.accounting;
  assert.equal(accounting.exploredCandidates, accounting.levels.reduce((sum, level) => sum + level.evaluated, 0));
  assert.ok(accounting.screening.length === 4);
  assert.ok(accounting.frequentCandidates >= 1);
  assert.ok(accounting.closedOutputs >= 1);
});

test('signed 只出现在事后分组，不改变支持度与模式集合', () => {
  const signedRows = [
    { visit: 'v1', buyer: 'b1', signed: true, tick: 0, zone: 'a' },
    { visit: 'v1', buyer: 'b1', signed: true, tick: 1, zone: 'b' },
    { visit: 'v2', buyer: 'b2', signed: false, tick: 0, zone: 'a' },
    { visit: 'v2', buyer: 'b2', signed: false, tick: 1, zone: 'b' },
  ];
  const result = discoverFromVisits(makeVisits(signedRows), policy({ minSupport: 2 }));
  const pattern = result.frozenPatterns.find(item => item.key === 'a>b');
  assert.equal(pattern.supportVisits, 2);
  assert.equal(pattern.groups.signedVisits, 1);
  assert.equal(pattern.groups.unsignedVisits, 1);
  assert.ok(pattern.groups.note.includes('事后'));
});
