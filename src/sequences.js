// 访问序列的领域模型与约束匹配。
//
// 序列单位是一个 buyer 的一次 visit：
//   - 同一 tick 的事件折叠为无序项集（zone 去重），文件中的行序不产生顺序语义；
//   - 不同 tick 按分钟升序排列，构成一个项集序列；
//   - 支持度等一切计数都按独立 visit 计算，visit 内重复事件不多算。
//
// discover 与 replay 必须共用本文件的匹配函数，保证两边匹配语义完全一致。

// 单次回访最多保留的匹配位置数；真实数据通常远小于此，仅为极密访问设置确定性上限。
export const MAX_EMBEDDINGS_PER_VISIT = 100;

export function patternKey(pattern) {
  return pattern.map(itemset => [...itemset].sort().join('&')).join('>');
}

export function parsePatternKey(key) {
  return key.split('>').map(step => step.split('&'));
}

// 把记录折叠为按 visit 组织的项集序列，并校验 visit 的主体一致性。
export function buildVisits(records) {
  const grouped = new Map();
  for (const record of records) {
    if (!grouped.has(record.visit)) {
      grouped.set(record.visit, {
        visit: record.visit,
        buyer: record.buyer,
        phase: record.phase,
        signed: record.signed,
        ticks: new Map(),
      });
    }
    const visit = grouped.get(record.visit);
    if (visit.buyer !== record.buyer) {
      throw new Error(`visit ${record.visit} 对应多个 buyer，无法作为独立序列单位`);
    }
    if (visit.signed !== record.signed) {
      throw new Error(`visit ${record.visit} 的 signed 标记不一致，无法按访问做事后分组`);
    }
    if (visit.phase !== record.phase) {
      throw new Error(`visit ${record.visit} 跨越多个 phase，无法归入单一冻结/复验场次`);
    }
    if (!visit.ticks.has(record.tick)) visit.ticks.set(record.tick, new Set());
    visit.ticks.get(record.tick).add(record.zone);
  }
  return [...grouped.values()].map(visit => ({
    visit: visit.visit,
    buyer: visit.buyer,
    phase: visit.phase,
    signed: visit.signed,
    steps: [...visit.ticks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([tick, zones]) => ({ tick, zones: [...zones].sort() })),
  }));
}

export function selectPhase(visits, phase) {
  return visits.filter(visit => visit.phase === phase);
}

function itemsetContains(step, itemset) {
  for (const zone of itemset) {
    if (!step.zones.includes(zone)) return false;
  }
  return true;
}

// 在一次 visit 中查找模式的全部匹配位置。
// 模式 pattern 是数组的数组：外层为有序步骤，内层为同刻（无序）zone 集合。
// 约束：
//   minGap <= t[k] - t[k-1] <= maxGap，且 t[last] - t[first] <= maxSpan；
//   步骤索引严格递增，即使 minGap = 0 也不允许复用同一个 tick。
// 返回匹配到的 tick 序列列表（每个元素是与模式步骤等长的 tick 数组）。
export function findEmbeddings(visit, pattern, constraints) {
  const { minGap, maxGap, maxSpan } = constraints;
  const embeddings = [];
  const chosen = [];

  function backtrack(stepIndex, lastTick, firstTick) {
    if (embeddings.length >= MAX_EMBEDDINGS_PER_VISIT) return;
    if (stepIndex === pattern.length) {
      embeddings.push([...chosen]);
      return;
    }
    const itemset = pattern[stepIndex];
    for (const candidate of visit.steps) {
      if (chosen.length && candidate.tick <= lastTick) continue;
      if (chosen.length && candidate.tick - lastTick < minGap) continue;
      if (chosen.length && candidate.tick - lastTick > maxGap) continue;
      if (chosen.length && candidate.tick - firstTick > maxSpan) continue;
      if (!itemsetContains(candidate, itemset)) continue;
      chosen.push(candidate.tick);
      backtrack(stepIndex + 1, candidate.tick, chosen.length === 1 ? candidate.tick : firstTick);
      chosen.pop();
      if (embeddings.length >= MAX_EMBEDDINGS_PER_VISIT) return;
    }
  }

  backtrack(0, null, null);
  return embeddings;
}

// 一次 visit 是否包含至少一个合法匹配。
export function visitMatches(visit, pattern, constraints) {
  return findEmbeddings(visit, pattern, constraints).length > 0;
}

// 在一个访问集合上清点支持访问（每个 visit 至多计一次），并返回证据。
export function matchVisits(visits, pattern, constraints) {
  const matches = [];
  for (const visit of visits) {
    const embeddings = findEmbeddings(visit, pattern, constraints);
    if (embeddings.length > 0) {
      matches.push({
        visit: visit.visit,
        buyer: visit.buyer,
        phase: visit.phase,
        signed: visit.signed,
        embeddingCount: embeddings.length,
        embeddingLimit: MAX_EMBEDDINGS_PER_VISIT,
        embeddingsTruncated: embeddings.length >= MAX_EMBEDDINGS_PER_VISIT,
        matchTicks: embeddings,
      });
    }
  }
  return matches;
}

// 从一条已有嵌入的模式出发，枚举所有仍可能有嵌入的单步扩展：
//   - 序列扩展：在更靠后的 tick 上追加单元素步骤；
//   - 项集扩展：把最后一个 tick 上同时出现的另一个 zone 并入末步（同刻、无序）。
// 新候选在每个支持 visit 内去重，再跨 visit 去重；候选键保证枚举确定。
// 匹配一律走 findEmbeddings，与 discover/replay 的支持度清点共用同一语义。
export function extendPattern(pattern, visits, constraints) {
  const candidates = new Map();
  const lastItemset = pattern[pattern.length - 1];

  for (const visit of visits) {
    const embeddings = findEmbeddings(visit, pattern, constraints);
    if (embeddings.length === 0) continue;
    const seenInVisit = new Set();

    for (const embedding of embeddings) {
      const lastTick = embedding[embedding.length - 1];
      const firstTick = embedding[0];

      for (const step of visit.steps) {
        // 项集扩展：只能并入末步匹配到的同一个 tick 上的同刻 zone。
        if (step.tick === lastTick) {
          for (const zone of step.zones) {
            if (lastItemset.includes(zone)) continue;
            const child = [...pattern.slice(0, -1), [...lastItemset, zone].sort()];
            const key = patternKey(child);
            if (!seenInVisit.has(key)) {
              seenInVisit.add(key);
              if (!candidates.has(key)) candidates.set(key, child);
            }
          }
          continue;
        }

        // 序列扩展：必须使用严格更靠后的 tick，并满足间隔与总跨度约束。
        if (step.tick < lastTick) continue;
        if (step.tick - lastTick < constraints.minGap) continue;
        if (step.tick - lastTick > constraints.maxGap) continue;
        if (step.tick - firstTick > constraints.maxSpan) continue;
        for (const zone of step.zones) {
          const child = [...pattern, [zone]];
          const key = patternKey(child);
          if (!seenInVisit.has(key)) {
            seenInVisit.add(key);
            if (!candidates.has(key)) candidates.set(key, child);
          }
        }
      }
    }
  }

  return [...candidates.values()].sort((left, right) => patternKey(left).localeCompare(patternKey(right), 'en'));
}

// 闭合判定：模式是闭合的，当且仅当不存在另一条已探索模式，
// 其包含本模式且支持它的独立 visit 集合包含本模式的支持集（允许相等）。
// 支持集相等时，更具体的超模式使本模式成为冗余表示，故不再闭合。
// 截断时该判定只在已探索候选范围内成立（由调用方另行标注）。
export function isClosed(pattern, supportVisitSet, allPatterns) {
  const key = patternKey(pattern);
  for (const [otherKey, other] of allPatterns) {
    if (otherKey === key) continue;
    if (!isSubPattern(pattern, other.pattern)) continue;
    if (containsAll(other.visits, supportVisitSet)) return false;
  }
  return true;
}

export function containsAll(superSet, subSet) {
  for (const visit of subSet) {
    if (!superSet.has(visit)) return false;
  }
  return true;
}

// 子序列关系（不含间隔约束，仅描述模式结构）：
// 每个子模式步骤都能在严格递增的超模式步骤中找到一个包含它的项集。
export function isSubPattern(subPattern, superPattern) {
  if (subPattern.length > superPattern.length) return false;
  let cursor = 0;
  for (const subItemset of subPattern) {
    let found = false;
    while (cursor < superPattern.length) {
      const superItemset = superPattern[cursor];
      cursor += 1;
      if (subItemset.every(zone => superItemset.includes(zone))) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}
