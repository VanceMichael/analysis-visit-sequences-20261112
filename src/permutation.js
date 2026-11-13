// 置换基线（permutation null）。
//
// 零假设：区域标签本身不携带跨刻序列信息，观测到的支持度只是热度与
// 访问结构的偶然产物。为了检验这一点，置换必须保留：
//   1. 每个 visit 的 tick 结构与访问长度（多少个 tick、每个 tick 多少事件）；
//   2. 同一 tick 的项集大小（distinct zone 数）；
//   3. 每个 zone 在全部记录中的总热度（事件计数不变）。
// 做法：在每个 visit 内部，用“跨 tick 组、且不制造同刻重复”的标签交换
// 重排区域标签。交换只发生在两个标签互不在对方所在 tick 出现的组之间，
// 因此每个 tick 的项集大小逐 tick 守恒；标签只在 visit 内移动，
// 每个标签的 visit 内出现次数守恒，跨 visit 的全局热度也守恒。
// 被破坏的只有“某标签在某 tick 出现”的跨刻搭配关系，即序列规律本身。

import { buildVisits, findEmbeddings } from './sequences.js';
import { constraintsOf } from './policy.js';

// 确定性 PRNG（mulberry32），使基线可复现、可审计。
export function createRng(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// 复制一份 visit 的步骤结构，便于在其上做标签置换。
function cloneVisits(visits) {
  return visits.map(visit => ({
    ...visit,
    steps: visit.steps.map(step => ({ tick: step.tick, zones: [...step.zones] })),
  }));
}

// 在一次 visit 内做一次保持结构的标签置换（原地修改）。
export function permuteVisit(visit, random) {
  // 收集标签占据的 tick 组（同 tick 重复标签在输入折叠后已不存在，
  // 这里仍按组处理，保证同刻项集大小不被破坏）。
  const groups = [];
  for (const step of visit.steps) {
    for (const zone of step.zones) {
      groups.push({ zone, tick: step.tick });
    }
  }
  if (groups.length < 2) return visit;

  // 每个标签当前出现的 tick 集合，用于检测交换是否会制造同刻重复。
  const ticksOfZone = new Map();
  for (const group of groups) {
    if (!ticksOfZone.has(group.zone)) ticksOfZone.set(group.zone, new Set());
    ticksOfZone.get(group.zone).add(group.tick);
  }

  // 多轮随机交换；交换条件保证任一 tick 的项集大小与 distinct 标签数不变。
  const rounds = groups.length * 4;
  for (let round = 0; round < rounds; round += 1) {
    const indexA = Math.floor(random() * groups.length);
    const indexB = Math.floor(random() * groups.length);
    if (indexA === indexB) continue;
    const a = groups[indexA];
    const b = groups[indexB];
    if (a.zone === b.zone || a.tick === b.tick) continue;
    const ticksA = ticksOfZone.get(a.zone);
    const ticksB = ticksOfZone.get(b.zone);
    if (ticksA.has(b.tick) || ticksB.has(a.tick)) continue;
    // 交换标签并维护 tick 索引。
    ticksA.delete(a.tick);
    ticksA.add(b.tick);
    ticksB.delete(b.tick);
    ticksB.add(a.tick);
    const moved = a.zone;
    a.zone = b.zone;
    b.zone = moved;
  }

  // 用置换后的组重建项集；按组回填可天然保持每个 tick 的标签数。
  const byTick = new Map(visit.steps.map(step => [step.tick, new Set()]));
  for (const group of groups) byTick.get(group.tick).add(group.zone);
  for (const step of visit.steps) {
    step.zones = [...byTick.get(step.tick)].sort();
  }
  return visit;
}

// 结构指纹：置换前后必须完全一致（访问长度、tick 列表、每 tick 项集大小、标签热度）。
export function structureSignature(visits) {
  const popularity = new Map();
  const perVisit = visits.map(visit => {
    const stepSizes = visit.steps.map(step => {
      for (const zone of step.zones) popularity.set(zone, (popularity.get(zone) ?? 0) + 1);
      return { tick: step.tick, size: step.zones.length };
    });
    return { visit: visit.visit, length: visit.steps.length, steps: stepSizes };
  });
  return {
    visitCount: visits.length,
    visits: perVisit,
    zonePopularity: [...popularity.entries()].sort(([a], [b]) => a.localeCompare(b, 'en')),
  };
}

function supportCount(visits, pattern, constraints) {
  let count = 0;
  for (const visit of visits) {
    if (findEmbeddings(visit, pattern, constraints).length > 0) count += 1;
  }
  return count;
}

// 对冻结模式集合跑置换基线。frozenPatterns 来自 discover 的冻结文件，
// 复验在 replayVisits 上进行；结构守恒在全部 visits 上核验。
export function permutationBaseline(frozenPatterns, replayVisits, allVisits, policy) {
  const constraints = constraintsOf(policy);
  const random = createRng(policy.rngSeed);
  const trials = policy.permutationTrials;
  const before = structureSignature(allVisits);

  const patternResults = frozenPatterns.map(frozen => ({
    key: frozen.key,
    pattern: frozen.pattern,
    closedWhenFrozen: frozen.closedWhenFrozen !== false,
    observedSupport: frozen.replaySupport ?? null,
    nullDistribution: [],
    nullGeObserved: 0,
    nullMin: null,
    nullMax: null,
    nullMean: null,
    empiricalP: null,
  }));
  const resultByKey = new Map(patternResults.map(result => [result.key, result]));
  const familyNullFrequent = [];

  for (let trial = 0; trial < trials; trial += 1) {
    const permutedAll = cloneVisits(allVisits).map(visit => permuteVisit(visit, random));
    const after = structureSignature(permutedAll);
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      throw new Error(`第 ${trial + 1} 次置换破坏了访问长度或同刻项集结构，基线无效`);
    }
    const replayIds = new Set(replayVisits.map(visit => visit.visit));
    const permutedReplay = permutedAll.filter(visit => replayIds.has(visit.visit));

    // 族级口径只统计闭合模式：单步等非闭合模式在热度守恒下必然频繁，
    // 计入“任一频繁”会让族级指标恒为 1，无法反映序列信号是否被置换破坏。
    let closedFrequent = false;
    for (const frozen of frozenPatterns) {
      const support = supportCount(permutedReplay, frozen.pattern, constraints);
      const result = resultByKey.get(frozen.key);
      result.nullDistribution.push(support);
      if (frozen.replaySupport !== null && support >= frozen.replaySupport) {
        result.nullGeObserved += 1;
      }
      if (result.closedWhenFrozen && support >= policy.minSupport) closedFrequent = true;
    }
    familyNullFrequent.push(closedFrequent ? 1 : 0);
  }

  for (const result of patternResults) {
    const values = result.nullDistribution;
    result.nullMin = Math.min(...values);
    result.nullMax = Math.max(...values);
    result.nullMean = values.reduce((sum, value) => sum + value, 0) / values.length;
    // +1 修正：即使零次超越，经验 p 值也不为 0，标注为“小于等于 1/(trials+1)”量级。
    result.empiricalP = (result.nullGeObserved + 1) / (trials + 1);
  }

  return {
    trials,
    rngSeed: policy.rngSeed,
    preserved: ['visit 长度与 tick 结构', '同 tick 项集大小', 'zone 全局热度（事件计数）'],
    structureVerified: true,
    familyLevel: {
      scope: '仅统计冻结时闭合的模式，避免非闭合的高频单步稀释族级口径',
      nullTrialsWithAnyFrequentClosedPattern: familyNullFrequent.reduce((sum, value) => sum + value, 0),
      nullRateOfAnyFrequentClosed: familyNullFrequent.reduce((sum, value) => sum + value, 0) / trials,
    },
    patterns: patternResults.map(result => ({
      key: result.key,
      pattern: result.pattern,
      observedSupport: result.observedSupport,
      nullGeObserved: result.nullGeObserved,
      nullMin: result.nullMin,
      nullMax: result.nullMax,
      nullMean: result.nullMean,
      nullDistribution: result.nullDistribution,
      empiricalP: result.empiricalP,
      note: `经验 p 值含 +1 修正；trials=${trials}，可分辨下限为 ${(1 / (trials + 1)).toFixed(5)}`,
    })),
  };
}

export function buildAllVisits(records) {
  return buildVisits(records);
}
