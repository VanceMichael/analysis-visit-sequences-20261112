import { readFile } from 'node:fs/promises';

const ALLOWED_KEYS = [
  'minSupport',
  'maxLength',
  'minGap',
  'maxGap',
  'maxSpan',
  'candidateLimit',
  'discoverPhase',
  'replayPhase',
  'permutationTrials',
  'rngSeed',
];

export const DEFAULT_POLICY = {
  minSupport: 2,
  maxLength: 4,
  minGap: 0,
  maxGap: 60,
  maxSpan: 180,
  candidateLimit: 500,
  discoverPhase: 'early',
  replayPhase: 'late',
  permutationTrials: 200,
  rngSeed: 0x5eed_0001,
};

function integer(value) {
  return Number.isSafeInteger(value);
}

export function validatePolicy(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('策略配置必须是对象');
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.includes(key)) throw new Error(`策略配置含未知字段：${key}`);
  }
  const policy = { ...DEFAULT_POLICY, ...raw };
  if (!integer(policy.minSupport) || policy.minSupport < 1) {
    throw new Error('minSupport 必须是不小于 1 的整数');
  }
  if (!integer(policy.maxLength) || policy.maxLength < 1) {
    throw new Error('maxLength 必须是不小于 1 的整数');
  }
  if (!integer(policy.minGap) || policy.minGap < 0) {
    throw new Error('minGap 必须是非负整数');
  }
  if (!integer(policy.maxGap) || policy.maxGap < policy.minGap) {
    throw new Error('maxGap 必须是不小于 minGap 的整数');
  }
  if (!integer(policy.maxSpan) || policy.maxSpan < 0 || policy.maxSpan < policy.maxGap) {
    throw new Error('maxSpan 必须是非负整数且不小于 maxGap');
  }
  if (!integer(policy.candidateLimit) || policy.candidateLimit < 1) {
    throw new Error('candidateLimit 必须是不小于 1 的整数');
  }
  if (typeof policy.discoverPhase !== 'string' || policy.discoverPhase.length === 0) {
    throw new Error('discoverPhase 必须是非空字符串');
  }
  if (typeof policy.replayPhase !== 'string' || policy.replayPhase.length === 0) {
    throw new Error('replayPhase 必须是非空字符串');
  }
  if (policy.discoverPhase === policy.replayPhase) {
    throw new Error('discoverPhase 与 replayPhase 必须是不同场次，才能先冻结再复验');
  }
  if (!integer(policy.permutationTrials) || policy.permutationTrials < 1) {
    throw new Error('permutationTrials 必须是不小于 1 的整数');
  }
  if (!integer(policy.rngSeed)) {
    throw new Error('rngSeed 必须是整数');
  }
  return policy;
}

export function constraintsOf(policy) {
  return {
    minGap: policy.minGap,
    maxGap: policy.maxGap,
    maxSpan: policy.maxSpan,
  };
}

export async function loadPolicy(path) {
  const raw = JSON.parse(await readFile(path, 'utf8'));
  return validatePolicy(raw);
}
