// The gist-comment wire format: how a submission is written, recognised and
// chosen. Every rule here has cost this project real orders in real inboxes —
// see DECISIONS.md, "A mailbox is created empty, and only ever edited" and
// "Never read a stale comment list".
//
// One module, two readers: the browser app and the unattended Action in
// tools/publish-moves.js, which imports these rather than carrying its own
// copy. So this suite covers both.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ORDERS_MARKER,
  MAILBOX_BODY,
  parseSubmission,
  submissionBody,
  findSubmission,
  findMyMailbox,
  upsertMovesEntry,
  extractGistId,
  movesFileName,
  samePhase,
} from '../js/submission-format.js';

const SUB = {
  power: 'france',
  year: 1901,
  season: 'spring',
  step: 'movement',
  orders: 'A Par - Bur',
};

// A GitHub comment object, cut down to the fields the format cares about.
let nextId = 100;
const comment = (login, body, { updated_at = null, created_at = '2026-01-01T00:00:00Z', id } = {}) => ({
  id: id ?? nextId++,
  user: { login },
  body,
  created_at,
  updated_at,
});

// ---------------------------------------------------------------------------
// marker + payload
// ---------------------------------------------------------------------------

test('a submission body round-trips through parseSubmission', () => {
  const parsed = parseSubmission(submissionBody(SUB));
  assert.deepEqual(parsed, SUB);
});

test('the mailbox placeholder is recognised as ours but is NOT a submission', () => {
  // It must carry the marker (so findMyMailbox edits it rather than posting a
  // second comment) and must fail parseSubmission (so an empty mailbox reads as
  // "— waiting", never as a power that submitted no orders).
  assert.ok(MAILBOX_BODY.startsWith(ORDERS_MARKER));
  assert.equal(parseSubmission(MAILBOX_BODY), null);
});

test('the legacy v1 marker is not mistaken for a prefix of the current one', () => {
  // 'DIPLOMACY-ORDERS v1' starts with 'DIPLOMACY-ORDERS'; matching as a prefix
  // rather than a whole first line would conflate the two.
  const legacy = 'DIPLOMACY-ORDERS v1\n' + JSON.stringify(SUB);
  assert.deepEqual(parseSubmission(legacy), SUB, 'legacy comments must still read');

  const current = parseSubmission(submissionBody(SUB));
  assert.deepEqual(current, SUB);
});

test('a comment that is not ours parses to null', () => {
  assert.equal(parseSubmission('just chatting about the game'), null);
  assert.equal(parseSubmission(''), null);
  assert.equal(parseSubmission(null), null);
  assert.equal(parseSubmission(undefined), null);
  // right marker, unparseable payload
  assert.equal(parseSubmission(ORDERS_MARKER + '\n{not json'), null);
  // right marker, valid JSON, missing the phase metadata
  assert.equal(parseSubmission(ORDERS_MARKER + '\n{"power":"france"}'), null);
});

test('a payload needs either cleartext orders or a sealed blob', () => {
  const { orders, ...noOrders } = SUB;
  assert.equal(parseSubmission(ORDERS_MARKER + '\n' + JSON.stringify(noOrders)), null);

  const sealed = { ...noOrders, sealed: 'BASE64BLOB' };
  assert.deepEqual(parseSubmission(ORDERS_MARKER + '\n' + JSON.stringify(sealed)), sealed);
});

// ---------------------------------------------------------------------------
// findSubmission — which comment counts as a login's submission
// ---------------------------------------------------------------------------

test('findSubmission finds a login’s submission, case-insensitively', () => {
  const comments = [
    comment('someone-else', submissionBody({ ...SUB, power: 'germany' })),
    comment('Player1', submissionBody(SUB), { updated_at: '2026-01-02T10:00:00Z' }),
  ];
  const found = findSubmission(comments, 'player1');
  assert.ok(found);
  assert.deepEqual(found.submission, SUB);
  assert.equal(found.updatedAt, '2026-01-02T10:00:00Z');

  assert.equal(findSubmission(comments, 'nobody'), null);
  assert.equal(findSubmission(comments, null), null);
});

test('among duplicates the most recently edited comment wins', () => {
  // Games played before submitOrders only ever edited one comment carry
  // duplicates. Preferring the older one would show superseded orders AND let
  // someone submit on time, edit a duplicate late, and pick their own stamp.
  const older = comment('player1', submissionBody({ ...SUB, orders: 'A Par H' }), {
    updated_at: '2026-01-02T10:00:00Z',
    id: 1,
  });
  const newer = comment('player1', submissionBody({ ...SUB, orders: 'A Par - Bur' }), {
    updated_at: '2026-01-02T18:00:00Z',
    id: 2,
  });
  // comments arrive oldest-first from GitHub
  assert.equal(findSubmission([older, newer], 'player1').submission.orders, 'A Par - Bur');
  assert.equal(findSubmission([newer, older], 'player1').submission.orders, 'A Par - Bur');
});

test('on an identical edit stamp the higher comment id wins', () => {
  const stamp = '2026-01-02T10:00:00Z';
  const a = comment('player1', submissionBody({ ...SUB, orders: 'A Par H' }), { updated_at: stamp, id: 7 });
  const b = comment('player1', submissionBody({ ...SUB, orders: 'A Par - Bur' }), { updated_at: stamp, id: 9 });
  assert.equal(findSubmission([a, b], 'player1').submission.orders, 'A Par - Bur');
  assert.equal(findSubmission([b, a], 'player1').submission.orders, 'A Par - Bur');
});

test('updatedAt is never backstopped with created_at', () => {
  // A mailbox is created when the player first opens the game, so created_at
  // can predate the submission by days. Treating it as a submission time would
  // wave a late edit through as on time. Absent means "unknown", which
  // submissionOnTime() resolves in the player's favour deliberately.
  const c = comment('player1', submissionBody(SUB), {
    created_at: '2026-01-01T00:00:00Z',
    updated_at: null,
  });
  assert.equal(findSubmission([c], 'player1').updatedAt, null);
});

// ---------------------------------------------------------------------------
// findMyMailbox — which comment a submit may PATCH
// ---------------------------------------------------------------------------

test('findMyMailbox prefers a real submission over a bare placeholder', () => {
  // findMyMailbox and findSubmission MUST agree, or a resubmit would edit one
  // comment while the UI went on reading another.
  const placeholder = comment('player1', MAILBOX_BODY, { updated_at: '2026-01-01T00:00:00Z', id: 1 });
  const submission = comment('player1', submissionBody(SUB), { updated_at: '2026-01-02T00:00:00Z', id: 2 });

  assert.equal(findMyMailbox([placeholder, submission], 'player1').id, 2);
  // ...even when the placeholder was touched more recently
  const freshPlaceholder = comment('player1', MAILBOX_BODY, { updated_at: '2026-01-03T00:00:00Z', id: 3 });
  assert.equal(findMyMailbox([submission, freshPlaceholder], 'player1').id, 2);
});

test('findMyMailbox never touches a comment without the marker', () => {
  // An ordinary chat comment on the gist must never be overwritten with orders.
  const chat = comment('player1', 'good luck everyone');
  assert.equal(findMyMailbox([chat], 'player1'), null);
  assert.equal(findMyMailbox([], 'player1'), null);
  assert.equal(findMyMailbox([comment('player1', MAILBOX_BODY)], null), null);
});

test('findMyMailbox finds a placeholder when that is all there is', () => {
  const placeholder = comment('player1', MAILBOX_BODY, { id: 42 });
  assert.equal(findMyMailbox([placeholder], 'PLAYER1').id, 42);
});

// ---------------------------------------------------------------------------
// moves-<power>.json
// ---------------------------------------------------------------------------

test('upsertMovesEntry replaces the entry for a phase rather than appending', () => {
  const phase = { year: 1901, season: 'spring', step: 'movement' };
  let doc = upsertMovesEntry(null, 'france', { ...phase, orders: 'A Par H' });
  assert.equal(doc.power, 'france');
  assert.equal(doc.history.length, 1);

  doc = upsertMovesEntry(doc, 'france', { ...phase, orders: 'A Par - Bur' });
  assert.equal(doc.history.length, 1, 'same phase must replace, not append');
  assert.equal(doc.history[0].orders, 'A Par - Bur');

  doc = upsertMovesEntry(doc, 'france', { year: 1901, season: 'fall', step: 'movement', orders: 'A Bur - Mun' });
  assert.equal(doc.history.length, 2, 'a new phase appends');
  assert.equal(doc.history[1].orders, 'A Bur - Mun', 'newest last');
});

test('upsertMovesEntry survives a malformed or missing document', () => {
  const entry = { year: 1901, season: 'spring', step: 'movement', orders: 'A Par H' };
  for (const bad of [null, undefined, {}, { history: 'not an array' }]) {
    const doc = upsertMovesEntry(bad, 'france', entry);
    assert.equal(doc.power, 'france');
    assert.deepEqual(doc.history, [entry]);
  }
});

test('movesFileName is the name readMovesFiles matches on', () => {
  assert.equal(movesFileName('france'), 'moves-france.json');
  assert.match(movesFileName('austria'), /^moves-([a-z]+)\.json$/);
});

// ---------------------------------------------------------------------------
// gist links
// ---------------------------------------------------------------------------

test('extractGistId accepts a bare id or a full gist URL', () => {
  const id = 'a1b2c3d4e5f60718';
  assert.equal(extractGistId(id), id);
  assert.equal(extractGistId(`  ${id}  `), id);
  assert.equal(extractGistId(`https://gist.github.com/someone/${id}`), id);
  assert.equal(extractGistId(`https://gist.github.com/someone/${id}/revisions`), id);

  assert.equal(extractGistId('not-a-gist'), null);
  assert.equal(extractGistId('deadbeef'), null, 'too short to be a gist id');
  assert.equal(extractGistId(''), null);
  assert.equal(extractGistId(null), null);
});

test('samePhase is the rule both the app and the Action match a phase with', () => {
  const phase = { year: 1901, season: 'spring', step: 'movement' };
  assert.equal(samePhase(phase, { ...phase, orders: 'A Par - Bur' }), true);
  assert.equal(samePhase(phase, { ...phase, year: 1902 }), false);
  assert.equal(samePhase(phase, { ...phase, season: 'fall' }), false);
  assert.equal(samePhase(phase, { ...phase, step: 'retreat' }), false);
  assert.equal(samePhase(phase, null), false);
  assert.equal(samePhase(phase, undefined), false);
});
