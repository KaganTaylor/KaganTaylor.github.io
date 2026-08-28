// The DATC suite under `node --test`, driving the same runner test/datc.html
// drives in a browser. The engine is pure, so the only thing the browser was
// ever needed for was fetching the case file — Node reads it from disk instead.
//
// This is the refactor's primary guard rail: 167 cases, one command, no tab.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { runAll } from './datc-runner.js';

const casesText = readFileSync(
  fileURLToPath(new URL('../tools/datc_v2.4_06.txt', import.meta.url)),
  'utf8'
);

test('DATC: all 167 Diplomacy Adjudicator Test Cases pass', async () => {
  const { failures, totalPass, total } = await runAll(casesText);

  // The count itself is asserted: a parsing change that silently dropped cases
  // would otherwise show as a green run over fewer of them.
  assert.equal(total, 167, `expected 167 cases, parsed ${total}`);

  const report = failures
    .map((f) => `  FAIL ${f.id} [${f.phase}]\n${f.notes.map((n) => `      ${n}`).join('\n')}`)
    .join('\n');
  assert.equal(failures.length, 0, `${failures.length} DATC failure(s):\n${report}`);
  assert.equal(totalPass, total);
});
