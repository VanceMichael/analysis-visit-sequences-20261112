import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { summarize } from '../src/domain.js';

const seed = JSON.parse(await readFile('data/records.json', 'utf8')).records[0];
const probe = patches => summarize(patches.map((patch, index) => ({...seed, id: `p${index}`, ...patch}))).groups[0];

test('到访量按独立访问清点，不重复计算同访问内的动作', () => {

  assert.equal(probe([{visit: 'a'}, {visit: 'a'}, {visit: 'b'}]).visits, 2);
  assert.equal(probe([{visit: 'a'}]).visits, 1);
});
