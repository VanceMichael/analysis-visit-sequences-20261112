// 冻结候选的复验回放。
//
// replay 不重新发现任何模式：它逐条加载 discover 冻结下来的模式，
// 用与 discover 完全相同的匹配器（sequences.findEmbeddings）在复验场次上重放，
// 并给出通过/未通过判定、展开证据与置换基线。
// 订单意向（signed）只在结果里做事后描述分组，不参与匹配、支持度与判定。

import { buildVisits, selectPhase, matchVisits } from './sequences.js';
import { constraintsOf } from './policy.js';
import { permutationBaseline } from './permutation.js';
import { recordsFingerprint } from './dataset.js';

export function replayFrozen(records, frozen, policy) {
  if (frozen.command !== 'discover' || frozen.result?.frozenPatterns === undefined) {
    throw new Error('冻结文件必须由 discover 命令产生，拒绝回放其他来源的文档');
  }
  if (typeof frozen.inputFingerprint !== 'string' || frozen.inputFingerprint.length === 0) {
    throw new Error('冻结文件缺少输入指纹，无法核验数据一致性，拒绝回放');
  }
  const expectedFingerprint = recordsFingerprint(records);
  if (frozen.inputFingerprint !== expectedFingerprint) {
    throw new Error('冻结文件的输入指纹与当前输入不一致，拒绝跨数据回放');
  }
  const frozenParams = frozen.result.params;
  const activeParams = {
    minSupport: policy.minSupport,
    maxLength: policy.maxLength,
    minGap: policy.minGap,
    maxGap: policy.maxGap,
    maxSpan: policy.maxSpan,
    candidateLimit: policy.candidateLimit,
  };
  const sameParams = Object.keys(frozenParams)
    .every(key => Object.hasOwn(activeParams, key) && activeParams[key] === frozenParams[key]);
  if (!sameParams) {
    throw new Error('当前策略参数与冻结文件不一致；复验必须沿用冻结时的间隔与支持度参数');
  }

  const allVisits = buildVisits(records);
  const replayVisits = selectPhase(allVisits, policy.replayPhase);
  if (replayVisits.length === 0) {
    throw new Error(`复验场次 ${policy.replayPhase} 没有任何 visit，无法回放`);
  }
  const constraints = constraintsOf(policy);

  const patternResults = frozen.result.frozenPatterns.map(frozenPattern => {
    const matches = matchVisits(replayVisits, frozenPattern.pattern, constraints);
    const supportVisits = new Set(matches.map(match => match.visit)).size;
    const signed = matches.filter(match => match.signed).length;
    const unsigned = matches.filter(match => !match.signed).length;
    return {
      key: frozenPattern.key,
      pattern: frozenPattern.pattern,
      length: frozenPattern.length,
      closedWhenFrozen: frozenPattern.closed,
      discoverySupport: frozenPattern.supportVisits,
      replaySupport: supportVisits,
      minSupport: policy.minSupport,
      verdict: supportVisits >= policy.minSupport ? '复验通过' : '复验未通过',
      replayRate: supportVisits / replayVisits.length,
      groups: {
        signedVisits: signed,
        unsignedVisits: unsigned,
        note: 'signed 只作事后描述分组，不进入访问项、匹配与判定',
      },
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
  });

  // 置换基线在复验场次上评估冻结模式，结构守恒核验覆盖全部 visit。
  const frozenWithReplaySupport = patternResults.map(result => ({ ...result }));
  const baseline = permutationBaseline(frozenWithReplaySupport, replayVisits, allVisits, policy);

  const passed = patternResults.filter(result => result.verdict === '复验通过').length;
  return {
    command: 'replay',
    frozenSource: {
      discoverPhase: frozen.result.phase,
      replayPhase: policy.replayPhase,
      inputFingerprint: frozen.inputFingerprint,
      frozenAt: frozen.generatedAt,
      frozenAccounting: frozen.result.accounting,
    },
    replay: {
      phase: policy.replayPhase,
      visitCount: replayVisits.length,
      params: activeParams,
      patternCount: patternResults.length,
      passed,
      failed: patternResults.length - passed,
      patterns: patternResults,
    },
    permutationBaseline: baseline,
    interpretation: {
      scope: '结果描述的是在复验场次上重复出现的访问路径及其适用 visit 范围，不构成因果结论',
      caution: '通过复验与置换基线仅支持“值得进一步试行”；导览顺序调整的因果提升需要后续受控试验确认',
    },
  };
}
