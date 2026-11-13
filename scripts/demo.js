import { main } from '../src/cli.js';
import { readFile } from 'node:fs/promises';

const started = performance.now();
console.log('读取本地演练记录并核对输入指纹');
console.log(JSON.stringify(await main(['inspect']), null, 2));
console.log('现有按区到访量核算（不用于路径发现）');
console.log(JSON.stringify(await main(['summary', '--out', 'var/summary.json']), null, 2));
console.log('业务配置（间隔、跨度、模式长度、候选上限、冻结/复验场次）');
const policy = JSON.parse(await readFile('data/policy.json', 'utf8'));
console.log(JSON.stringify(policy, null, 2));

console.log('前半场（early）发现并冻结候选');
const frozen = await main(['discover', '--out', 'var/frozen.json']);
console.log(JSON.stringify({
  phase: frozen.result.phase,
  visitCount: frozen.result.visitCount,
  accounting: frozen.result.accounting,
  closedPatterns: frozen.result.frozenPatterns
    .filter(item => item.closed)
    .map(item => ({ key: item.key, supportVisits: item.supportVisits, groups: item.groups })),
}, null, 2));

console.log('后半场（late）只回放冻结候选，不重新发现，并给出置换基线');
const replay = await main(['replay', '--frozen', 'var/frozen.json', '--out', 'var/replay.json']);
console.log(JSON.stringify({
  replay: {
    phase: replay.replay.phase,
    visitCount: replay.replay.visitCount,
    passed: replay.replay.passed,
    failed: replay.replay.failed,
  },
  familyLevel: replay.permutationBaseline.familyLevel,
  interpretation: replay.interpretation,
}, null, 2));
console.log(`完成，用时 ${Math.ceil(performance.now() - started)} 毫秒`);
