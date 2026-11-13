import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVisits,
  findEmbeddings,
  matchVisits,
  extendPattern,
  isClosed,
  isSubPattern,
  patternKey,
  MAX_EMBEDDINGS_PER_VISIT,
} from '../src/sequences.js';

const base = { buyer: 'b', visit: 'v', tick: 0, zone: 'z', phase: 'early', signed: false, id: 'r' };
const row = (patch, index) => ({ ...base, id: `r${index}`, ...patch });
const make = rows => buildVisits(rows.map((patch, index) => row(patch, index)));
const constraints = { minGap: 0, maxGap: 60, maxSpan: 180 };

test('同一 tick 的动作折叠为无序项集，文件行序不产生顺序语义', () => {
  const forward = make([
    { tick: 0, zone: 'a' }, { tick: 0, zone: 'b' }, { tick: 1, zone: 'c' },
  ]);
  const reverse = make([
    { tick: 1, zone: 'c' }, { tick: 0, zone: 'b' }, { tick: 0, zone: 'a' },
  ]);
  assert.deepEqual(forward[0].steps, reverse[0].steps);
  assert.deepEqual(forward[0].steps[0].zones, ['a', 'b']);
  // 同刻项集无序：两个方向的模式都应在同一个 tick 上命中。
  assert.equal(findEmbeddings(forward[0], [['a', 'b']], constraints).length, 1);
  assert.equal(findEmbeddings(forward[0], [['b', 'a']], constraints).length, 1);
  // 同刻项集内不存在先后：不允许把同 tick 的两个 zone 当成有序两步。
  assert.deepEqual(findEmbeddings(forward[0], [['a'], ['b']], constraints), []);
});

test('重复事件在同刻项集去重，支持度按独立 visit 计，重复十遍不多算', () => {
  const repeated = make(Array.from({ length: 10 }, () => ({ tick: 5, zone: 'a' })));
  assert.deepEqual(repeated[0].steps, [{ tick: 5, zones: ['a'] }]);
  const twoVisits = make([
    ...Array.from({ length: 10 }, (_, index) => ({ visit: 'v1', tick: index, zone: 'a' })),
    { visit: 'v2', tick: 0, zone: 'a' },
  ]);
  const matches = matchVisits(twoVisits, [['a']], constraints);
  assert.equal(matches.length, 2);
  assert.deepEqual(matches.map(match => match.visit).sort(), ['v1', 'v2']);
});

test('minGap 约束：相邻步骤必须满足最短间隔，minGap=0 也不得复用同一 tick', () => {
  const visits = make([
    { tick: 0, zone: 'a' }, { tick: 5, zone: 'b' }, { tick: 5, zone: 'c' },
  ]);
  assert.equal(findEmbeddings(visits[0], [['a'], ['b']], { minGap: 0, maxGap: 60, maxSpan: 180 }).length, 1);
  assert.deepEqual(findEmbeddings(visits[0], [['a'], ['b']], { minGap: 6, maxGap: 60, maxSpan: 180 }), []);
  // 同刻的 b、c 不能因为 minGap=0 被当作两个有序步骤。
  assert.deepEqual(findEmbeddings(visits[0], [['b'], ['c']], constraints), []);
});

test('maxGap 约束：跨窗口的合法模式不允许漏掉，窗口内的多位置要全部枚举', () => {
  const visits = make([
    { tick: 0, zone: 'a' }, { tick: 10, zone: 'b' },
    { tick: 20, zone: 'b' }, { tick: 100, zone: 'b' },
  ]);
  const tight = findEmbeddings(visits[0], [['a'], ['b']], { minGap: 0, maxGap: 15, maxSpan: 180 });
  assert.deepEqual(tight, [[0, 10]]);
  const loose = findEmbeddings(visits[0], [['a'], ['b']], { minGap: 0, maxGap: 100, maxSpan: 180 });
  assert.deepEqual(loose, [[0, 10], [0, 20], [0, 100]]);
});

test('maxSpan 约束：总跨度超限时剪除，首个 tick 固定为跨度起点', () => {
  const visits = make([
    { tick: 0, zone: 'a' }, { tick: 40, zone: 'b' }, { tick: 90, zone: 'c' },
  ]);
  assert.equal(
    findEmbeddings(visits[0], [['a'], ['b'], ['c']], { minGap: 0, maxGap: 60, maxSpan: 180 }).length,
    1,
  );
  assert.deepEqual(
    findEmbeddings(visits[0], [['a'], ['b'], ['c']], { minGap: 0, maxGap: 60, maxSpan: 89 }),
    [],
  );
});

test('项集扩展与序列扩展都从实际匹配位置生成，且跨 visit 去重', () => {
  const visits = make([
    { visit: 'v1', tick: 0, zone: 'a' }, { visit: 'v1', tick: 10, zone: 'b' }, { visit: 'v1', tick: 10, zone: 'c' },
    { visit: 'v2', tick: 0, zone: 'a' }, { visit: 'v2', tick: 10, zone: 'b' }, { visit: 'v2', tick: 20, zone: 'd' },
  ]);
  const children = extendPattern([['a']], visits, constraints);
  const keys = children.map(patternKey);
  assert.ok(keys.includes('a>b')); // 序列扩展
  assert.ok(keys.includes('a>c'));
  assert.ok(keys.includes('a>d'));
  assert.equal(new Set(keys).size, keys.length); // 无重复候选
  // 同刻出现的 c 不会被生成成 a>c 的同 tick 嵌入；a>c 必须落在 tick 10 的后续步骤语义上。
  const embedding = findEmbeddings(visits[0], [['a'], ['c']], constraints);
  assert.deepEqual(embedding, [[0, 10]]);
});

test('闭合判定：支持集相同的更具体超模式使子模式不闭合', () => {
  const all = new Map([
    ['a', { pattern: [['a']], visits: new Set(['v1', 'v2']) }],
    ['a>b', { pattern: [['a'], ['b']], visits: new Set(['v1', 'v2']) }],
  ]);
  assert.equal(isClosed([['a']], new Set(['v1', 'v2']), all), false);
  assert.equal(isClosed([['a'], ['b']], new Set(['v1', 'v2']), all), true);
});

test('子序列关系按项集包含与严格步骤递增判定', () => {
  assert.equal(isSubPattern([['a']], [['a', 'x'], ['b']]), true);
  assert.equal(isSubPattern([['a'], ['b']], [['a', 'x'], ['b']]), true);
  assert.equal(isSubPattern([['b'], ['a']], [['a'], ['b']]), false);
  assert.equal(isSubPattern([['a'], ['b'], ['c']], [['a'], ['b']]), false);
});

test('visit 主体一致性被强制校验', () => {
  assert.throws(() => make([
    { visit: 'v1', buyer: 'b1' }, { visit: 'v1', buyer: 'b2', zone: 'a' },
  ]), /buyer/);
  assert.throws(() => make([
    { visit: 'v1', signed: true }, { visit: 'v1', signed: false, zone: 'a' },
  ]), /signed/);
  assert.throws(() => make([
    { visit: 'v1', phase: 'early' }, { visit: 'v1', phase: 'late', zone: 'a' },
  ]), /phase/);
});

test('极密访问下匹配位置超过上限时显式截断且不伪造数量', () => {
  const rows = [{ tick: 0, zone: 'a' }];
  for (let tick = 1; tick <= MAX_EMBEDDINGS_PER_VISIT + 5; tick += 1) {
    rows.push({ tick, zone: 'b' });
  }
  const visits = make(rows);
  // 不设间隔窗口，每个后续 b 都是一个合法匹配位置，嵌入数必然超过上限。
  const unconstrained = { minGap: 0, maxGap: Number.MAX_SAFE_INTEGER, maxSpan: Number.MAX_SAFE_INTEGER };
  const matches = matchVisits(visits, [['a'], ['b']], unconstrained);
  assert.equal(matches[0].embeddingsTruncated, true);
  assert.equal(matches[0].embeddingCount, MAX_EMBEDDINGS_PER_VISIT);
  // 未触顶时给出真实匹配数，不提前截断。
  const smaller = make([
    { tick: 0, zone: 'a' },
    ...Array.from({ length: 3 }, (_, index) => ({ tick: index + 1, zone: 'b' })),
  ]);
  const smallMatches = matchVisits(smaller, [['a'], ['b']], constraints);
  assert.equal(smallMatches[0].embeddingsTruncated, false);
  assert.equal(smallMatches[0].embeddingCount, 3);
});
