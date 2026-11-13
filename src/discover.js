// 访问序列发现（宽度优先、闭合输出）。
//
// 关键正确性取舍：
//   带 maxGap/maxSpan 间隔约束后，Apriori 的支持度反单调性不再成立——
//   一条不频繁的子模式完全可能有频繁的超模式（子模式的匹配位置被窗口约束切碎，
//   而更长的模式反而落在可行窗口内）。因此本引擎不以支持度剪枝，
//   只剪枝“零嵌入”分支：没有任何匹配的模式，其任何超集也不可能有匹配，
//   这一条在任意间隔约束下都成立。其余候选一律枚举到 maxLength，
//   由 candidateLimit 兜底；一旦触顶即 truncated=true，绝不把“没搜完”说成“没有其他模式”。

import {
  buildVisits,
  selectPhase,
  patternKey,
  extendPattern,
  matchVisits,
  isClosed,
} from './sequences.js';
import { constraintsOf } from './policy.js';

function summarizeGroups(matches) {
  const signedVisits = new Set();
  const unsignedVisits = new Set();
  for (const match of matches) {
    if (match.signed) signedVisits.add(match.visit);
    else unsignedVisits.add(match.visit);
  }
  return {
    signedVisits: signedVisits.size,
    unsignedVisits: unsignedVisits.size,
    // signed 仅用于事后描述分组，不参与模式发现与支持度计算。
    note: 'signed 只作事后描述分组，不进入访问项与支持度',
  };
}

function buildFrozenPattern(entry, allPatterns) {
  const { pattern, matches, level } = entry;
  return {
    key: patternKey(pattern),
    pattern,
    length: level,
    supportVisits: entry.visits.size,
    closed: isClosed(pattern, entry.visits, allPatterns),
    groups: summarizeGroups(matches),
    evidence: matches.map(match => ({
      visit: match.visit,
      buyer: match.buyer,
      phase: match.phase,
      signed: match.signed,
      embeddingCount: match.embeddingCount,
      embeddingLimit: match.embeddingLimit,
      embeddingsTruncated: match.embeddingsTruncated,
      matchTicks: match.matchTicks,
    })),
  };
}

// 在给定访问集合上做穷尽式（受 candidateLimit 约束）发现。
export function discoverFromVisits(visits, policy) {
  const constraints = constraintsOf(policy);
  // allPatterns 仅登记“至少有一个嵌入”的候选，连同其匹配证据，供闭合判定与输出复用。
  const allPatterns = new Map();
  const levelCounts = [];
  let explored = 0;
  let zeroEmbedding = 0;
  let truncated = false;
  let truncationPoint = null;

  // 第 1 层候选：数据中出现过的全部 distinct zone（单元素项集）。
  const zoneNames = new Set();
  for (const visit of visits) {
    for (const step of visit.steps) {
      for (const zone of step.zones) zoneNames.add(zone);
    }
  }
  let frontier = [...zoneNames].sort().map(zone => [[zone]]);
  const enqueued = new Set(frontier.map(patternKey));

  for (let level = 1; level <= policy.maxLength && frontier.length > 0; level += 1) {
    levelCounts.push({ level, evaluated: 0, feasible: 0, frequent: 0 });
    const nextFrontier = [];

    for (const pattern of frontier) {
      if (explored >= policy.candidateLimit) {
        truncated = true;
        truncationPoint = truncationPoint ?? `第 ${level} 层评估前达到候选上限，该层尚有未评估候选`;
        break;
      }
      explored += 1;
      levelCounts[level - 1].evaluated += 1;
      const matches = matchVisits(visits, pattern, constraints);
      if (matches.length === 0) {
        zeroEmbedding += 1;
        continue;
      }
      levelCounts[level - 1].feasible += 1;
      const visitSet = new Set(matches.map(match => match.visit));
      allPatterns.set(patternKey(pattern), { pattern, visits: visitSet, support: visitSet.size, matches, level });
      if (visitSet.size >= policy.minSupport) levelCounts[level - 1].frequent += 1;
      if (level === policy.maxLength) continue;

      // 只从有嵌入的模式继续扩展；零嵌入分支在此处被安全剪枝。
      for (const child of extendPattern(pattern, visits, constraints)) {
        const childKey = patternKey(child);
        if (enqueued.has(childKey)) continue;
        // candidateLimit 约束“已评估候选数”：已评估 explored 个，
        // 当前 frontier 至少还会评估（自身剩余 + 已入队未评估）个，触顶即停止入队。
        if (explored >= policy.candidateLimit) {
          truncated = true;
          truncationPoint = `第 ${level} 层扩展入队时达到候选上限`;
          break;
        }
        enqueued.add(childKey);
        nextFrontier.push(child);
      }
      if (truncated) break;
    }

    frontier = nextFrontier;
    if (truncated) break;
  }

  const frequentEntries = [...allPatterns.values()].filter(entry => entry.support >= policy.minSupport);
  const closedEntries = frequentEntries.filter(entry => isClosed(entry.pattern, entry.visits, allPatterns));
  const frozenPatterns = frequentEntries
    .map(entry => buildFrozenPattern(entry, allPatterns))
    .sort(comparePatterns);

  return {
    params: {
      minSupport: policy.minSupport,
      maxLength: policy.maxLength,
      minGap: policy.minGap,
      maxGap: policy.maxGap,
      maxSpan: policy.maxSpan,
      candidateLimit: policy.candidateLimit,
    },
    accounting: {
      exploredCandidates: explored,
      enqueuedCandidates: enqueued.size,
      candidateLimit: policy.candidateLimit,
      truncated,
      truncationPoint,
      truncationReason: truncated ? '候选数量达到 candidateLimit，后续层级与兄弟分支未继续搜索，输出不代表全部模式' : null,
      closureScope: truncated ? '闭合判定仅覆盖已探索候选，截断可能遗漏更具体的闭合超模式' : '覆盖全部可行候选',
      zeroEmbeddingPruned: zeroEmbedding,
      frequentCandidates: frequentEntries.length,
      closedOutputs: closedEntries.length,
      levels: levelCounts,
      screening: [
        { stage: '枚举', rule: '从 distinct zone 起步，按序列扩展与同刻项集扩展逐层生成，跨 visit 去重', evaluated: explored },
        { stage: '零嵌入剪枝', rule: '仅剪枝在任何 visit 都无匹配的候选；间隔约束下不按支持度剪枝，避免漏掉合法超模式', dropped: zeroEmbedding },
        { stage: '支持度筛选', rule: `独立 visit 支持数 >= minSupport(${policy.minSupport})，同一 visit 多次匹配只计一次`, kept: frequentEntries.length },
        { stage: '闭合筛选', rule: '剔除存在包含它的超模式、且该超模式支持 visit 集合包含本模式支持集（含相等）的候选', kept: closedEntries.length, dropped: frequentEntries.length - closedEntries.length },
      ],
    },
    frozenPatterns,
  };
}

function comparePatterns(left, right) {
  if (right.supportVisits !== left.supportVisits) return right.supportVisits - left.supportVisits;
  if (right.length !== left.length) return right.length - left.length;
  return left.key.localeCompare(right.key, 'en');
}

export function discover(records, policy, phase) {
  const visits = selectPhase(buildVisits(records), phase);
  return {
    phase,
    visitCount: visits.length,
    ...discoverFromVisits(visits, policy),
  };
}
