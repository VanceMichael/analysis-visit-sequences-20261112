import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRng,
  permuteVisit,
  structureSignature,
  permutationBaseline,
} from '../src/permutation.js';
import { buildVisits } from '../src/sequences.js';
import { validatePolicy, DEFAULT_POLICY } from '../src/policy.js';

const base = { buyer: 'b', visit: 'v', tick: 0, zone: 'z', phase: 'early', signed: false, id: 'r' };
const makeVisits = rows => buildVisits(rows.map((patch, index) => ({ ...base, id: `r${index}`, ...patch })));
const policy = override => validatePolicy({ ...DEFAULT_POLICY, ...override });

test('置换保留访问长度、tick 列表、同刻项集大小与全局热度', () => {
  const rows = [
    { visit: 'v1', buyer: 'b1', tick: 0, zone: 'a' }, { visit: 'v1', buyer: 'b1', tick: 0, zone: 'b' },
    { visit: 'v1', buyer: 'b1', tick: 10, zone: 'b' }, { visit: 'v1', buyer: 'b1', tick: 10, zone: 'c' },
    { visit: 'v2', buyer: 'b2', tick: 0, zone: 'a' }, { visit: 'v2', buyer: 'b2', tick: 20, zone: 'd' },
  ];
  const visits = makeVisits(rows);
  const before = structureSignature(visits);
  const random = createRng(42);
  const permuted = visits.map(visit => permuteVisit(structuredClone(visit), random));
  assert.deepEqual(structureSignature(permuted), before);
});

test('同刻标签永不互换：置换后每个 tick 仍是 distinct 标签且项集大小不变', () => {
  const rows = [
    { visit: 'v1', buyer: 'b1', tick: 0, zone: 'a' }, { visit: 'v1', buyer: 'b1', tick: 0, zone: 'b' },
    { visit: 'v1', buyer: 'b1', tick: 1, zone: 'a' }, { visit: 'v1', buyer: 'b1', tick: 1, zone: 'b' },
  ];
  const visits = makeVisits(rows);
  const random = createRng(7);
  for (let trial = 0; trial < 50; trial += 1) {
    const permuted = visits.map(visit => permuteVisit(structuredClone(visit), random));
    for (const visit of permuted) {
      for (const step of visit.steps) {
        assert.equal(new Set(step.zones).size, step.zones.length);
        assert.equal(step.zones.length, 2);
      }
    }
  }
});

test('相同种子产生可复现的置换序列', () => {
  const visits = makeVisits([
    { tick: 0, zone: 'a' }, { tick: 1, zone: 'b' }, { tick: 2, zone: 'c' },
  ]);
  const run = () => {
    const random = createRng(123);
    return permuteVisit(structuredClone(visits[0]), random).steps.map(step => step.zones);
  };
  assert.deepEqual(run(), run());
});

test('置换基线在强序列信号上给出小经验 p 值，并逐次核验结构守恒', () => {
  const rows = [];
  for (let visitIndex = 0; visitIndex < 8; visitIndex += 1) {
    const visit = `v${visitIndex}`;
    rows.push({ visit, buyer: visit, tick: 0, zone: 'a' });
    rows.push({ visit, buyer: visit, tick: 5, zone: 'b' });
    rows.push({ visit, buyer: visit, tick: 9, zone: 'c' });
  }
  const visits = makeVisits(rows);
  const frozen = [{
    key: 'a>b>c',
    pattern: [['a'], ['b'], ['c']],
    replaySupport: 8,
    length: 3,
  }];
  const result = permutationBaseline(frozen, visits, visits, policy({ permutationTrials: 100, rngSeed: 99 }));
  assert.equal(result.patterns.length, 1);
  assert.equal(result.structureVerified, true);
  assert.equal(result.patterns[0].observedSupport, 8);
  assert.ok(result.patterns[0].empiricalP <= 0.05);
  assert.equal(result.patterns[0].nullDistribution.length, 100);
  assert.ok(result.patterns[0].nullMax < 8);
});

test('无信号数据上置换基线不会系统性低估 p 值（零分布与观测同量级）', () => {
  // 构造 12 个结构相同、但跨 tick 标签轮转的 visit：不存在跨 visit 稳定的标签序列。
  const rows = [];
  const zones = ['a', 'b', 'c', 'd'];
  for (let visitIndex = 0; visitIndex < 12; visitIndex += 1) {
    const visit = `v${visitIndex}`;
    for (let tick = 0; tick < 4; tick += 1) {
      rows.push({ visit, buyer: visit, tick: tick * 3, zone: zones[(tick + visitIndex) % zones.length] });
    }
  }
  const visits = makeVisits(rows);
  const observed = visits.filter(visit =>
    visit.steps.length >= 2 &&
    visit.steps[0].zones.includes('a') &&
    visit.steps[1].zones.includes('b')).length;
  const frozen = [{
    key: 'a>b',
    pattern: [['a'], ['b']],
    replaySupport: observed,
    length: 2,
  }];
  const result = permutationBaseline(frozen, visits, visits, policy({ permutationTrials: 100, rngSeed: 5 }));
  const stats = result.patterns[0];
  // 观测值落在零分布支撑区间内，且 +1 修正后的经验 p 值不显著。
  assert.ok(observed >= stats.nullMin);
  assert.ok(observed <= stats.nullMax + 1);
  assert.ok(stats.empiricalP > 0.05);
  assert.ok(stats.nullMean >= 0);
});
