import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePolicy, DEFAULT_POLICY, constraintsOf } from '../src/policy.js';

test('合法策略补齐默认值并暴露匹配约束', () => {
  const policy = validatePolicy({ minSupport: 3 });
  assert.equal(policy.minSupport, 3);
  assert.equal(policy.maxGap, DEFAULT_POLICY.maxGap);
  assert.deepEqual(constraintsOf(policy), {
    minGap: policy.minGap, maxGap: policy.maxGap, maxSpan: policy.maxSpan,
  });
});

test('未知字段被拒绝，避免拼写错误静默失效', () => {
  assert.throws(() => validatePolicy({ maxgap: 5 }), /未知字段/);
});

test('间隔与跨度的数值约束被强制检查', () => {
  assert.throws(() => validatePolicy({ minSupport: 0 }), /minSupport/);
  assert.throws(() => validatePolicy({ maxLength: 0 }), /maxLength/);
  assert.throws(() => validatePolicy({ minGap: -1 }), /minGap/);
  assert.throws(() => validatePolicy({ minGap: 10, maxGap: 5 }), /maxGap/);
  assert.throws(() => validatePolicy({ maxGap: 60, maxSpan: 10 }), /maxSpan/);
  assert.throws(() => validatePolicy({ candidateLimit: 0 }), /candidateLimit/);
  assert.throws(() => validatePolicy({ permutationTrials: 0 }), /permutationTrials/);
  assert.throws(() => validatePolicy({ rngSeed: 1.5 }), /rngSeed/);
});

test('冻结场次与复验场次必须不同', () => {
  assert.throws(() => validatePolicy({ discoverPhase: 'x', replayPhase: 'x' }), /不同场次/);
  assert.throws(() => validatePolicy({ discoverPhase: '' }), /discoverPhase/);
});
