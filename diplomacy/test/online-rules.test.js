// Deadlines and submissions (js/online-rules.js).
//
// This is the part of the app with an actual incident history, all of it
// written up in DECISIONS.md, and none of it previously testable: a Spring 1901
// deadline that outlived its phase and auto-published an all-hold Fall 1901; a
// comment edited after the deadline judged by whichever stamp suited it; a
// deadline gate a player could beat by moving their device clock.
//
// Each guard below has a case that names the thing it prevents.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  matchesPhase, currentPhase, activePowers, hasAssignedPlayers, publishMode,
  trustedNow, deadlineDate, deadlinePassed, deadlineUrgency, deadlineIsForCurrentPhase,
  ordersOpen, lateResubmitAllowed, isSubmitAllowed, submissionOnTime,
  phaseSubmission, mySubmission, revealedEntry, powerOnlineStatus,
  gatherPhaseBlocks, deadlineChainBase, bumpUnavailableReason, bumpTarget,
  viewerPosition, extendsOurHistory,
} from '../js/online-rules.js';
import { submissionBody } from '../js/publish.js';
import { newGame } from '../js/state.js';
import { splitOrdersByPower, blockBody } from '../js/orders-text.js';

const HOUR = 3600000;
const PAST = new Date(Date.now() - 2 * HOUR).toISOString();
const FUTURE = new Date(Date.now() + 2 * HOUR).toISOString();

// A published game mid-Spring-1901 with two powers assigned.
const published = (over = {}) => ({
  ...newGame('the real game'),
  published: true,
  gistId: 'abc123',
  players: { france: 'fra-player', england: 'eng-player' },
  ...over,
});

// A submission comment from `login` for the given phase.
const submission = (login, power, orders, { phase = {}, updated_at = FUTURE } = {}) => ({
  id: login + '-1',
  user: { login },
  created_at: PAST,
  updated_at,
  body: submissionBody({
    power, year: 1901, season: 'spring', step: 'movement', orders, ...phase,
  }),
});

const snapshot = (over = {}) => ({
  comments: null, moves: null, login: null, serverOffset: 0, sealKey: null, ...over,
});

// ---------------------------------------------------------------------------
// the phase on the table
// ---------------------------------------------------------------------------

test('matchesPhase compares all three parts of a phase', () => {
  const g = published();
  assert.equal(matchesPhase(g, { year: 1901, season: 'spring', step: 'movement' }), true);
  assert.equal(matchesPhase(g, { year: 1902, season: 'spring', step: 'movement' }), false);
  assert.equal(matchesPhase(g, { year: 1901, season: 'fall', step: 'movement' }), false);
  assert.equal(matchesPhase(g, { year: 1901, season: 'spring', step: 'retreat' }), false);
  assert.equal(matchesPhase(g, null), false);
  assert.deepEqual(currentPhase(g), { year: 1901, season: 'spring', step: 'movement' });
});

test('activePowers is everyone still holding a unit or a centre', () => {
  const g = published();
  assert.equal(activePowers(g).length, 7);

  g.units = g.units.filter((u) => u.power !== 'italy');
  for (const [c, o] of Object.entries(g.scOwners)) if (o === 'italy') g.scOwners[c] = null;
  assert.ok(!activePowers(g).includes('italy'), 'eliminated powers drop out');

  // a power with centres but no units is still in the game (it owes builds)
  g.units = g.units.filter((u) => u.power !== 'turkey');
  assert.ok(activePowers(g).includes('turkey'));
});

test('hasAssignedPlayers gates the whole online UI', () => {
  assert.equal(hasAssignedPlayers(published()), true);
  assert.equal(hasAssignedPlayers(published({ players: {} })), false);
  assert.equal(hasAssignedPlayers(published({ players: { france: '' } })), false);
  assert.equal(hasAssignedPlayers(newGame('sandbox')), false, 'a sandbox has no players');
  assert.equal(hasAssignedPlayers(null), false);
});

test('manual is the publish mode unless auto is set explicitly', () => {
  assert.equal(publishMode(published()), 'manual');
  assert.equal(publishMode(published({ publishMode: null })), 'manual');
  assert.equal(publishMode(published({ publishMode: 'auto' })), 'auto');
});

// ---------------------------------------------------------------------------
// the clock — a player must not be able to beat it with their device settings
// ---------------------------------------------------------------------------

test('the deadline gate reads GitHub’s clock, not the device’s', () => {
  // The deadline is an hour away by the device clock, but this device is two
  // hours fast — a player who set their clock forward to peek early.
  const g = published({ deadline: new Date(Date.now() + HOUR).toISOString() });
  const spoofed = snapshot({ serverOffset: -2 * HOUR });

  assert.ok(trustedNow(spoofed) < Date.now(), 'corrected back to real time');
  assert.equal(deadlinePassed(g, spoofed), false, 'still open on GitHub’s clock');
  assert.equal(ordersOpen(g, spoofed), true);
});

test('with no server date yet the raw local clock is used, which fails safe', () => {
  const g = published({ deadline: FUTURE });
  const offline = snapshot(); // serverOffset 0 — nothing fetched yet
  assert.equal(deadlinePassed(g, offline), false);
  assert.equal(trustedNow(offline), trustedNow(snapshot({ serverOffset: 0 })));
});

test('deadlineUrgency and deadlinePassed can never disagree', () => {
  // Three indicators read deadlineUrgency and one gate reads deadlinePassed;
  // when they used different clocks the page could show a live countdown over
  // a closed submit button.
  const g = published({ deadline: new Date(Date.now() + HOUR).toISOString() });
  for (const offset of [0, 2 * HOUR, -2 * HOUR, 6 * HOUR, -6 * HOUR]) {
    const o = snapshot({ serverOffset: offset });
    const passed = deadlinePassed(g, o);
    assert.equal(deadlineUrgency(g, o), passed ? 'danger' : 'warn', `offset ${offset}`);
    assert.equal(ordersOpen(g, o), !passed, `offset ${offset}`);
  }
});

test('no deadline is its own state, and closes submissions', () => {
  const g = published({ deadline: null });
  const o = snapshot();
  assert.equal(deadlineDate(g), null);
  assert.equal(deadlineUrgency(g, o), 'none');
  assert.equal(deadlinePassed(g, o), false, 'nothing to have passed');
  assert.equal(ordersOpen(g, o), false, 'but nothing to be on time against either');

  assert.equal(deadlineDate(published({ deadline: 'not a date' })), null);
});

// ---------------------------------------------------------------------------
// a deadline belongs to a phase, not to a clock
// ---------------------------------------------------------------------------

test('an expired deadline cannot be carried into the next phase', () => {
  // The incident: a Spring 1901 deadline passed, the board advanced to Fall
  // 1901 without it being cleared, and auto-publish resolved a phase nobody
  // had ordered in because it only ever asked "is it in the past?".
  const g = published({
    deadline: PAST,
    deadlineFor: { year: 1901, season: 'spring', step: 'movement' },
  });
  const o = snapshot();

  assert.equal(deadlinePassed(g, o), true);
  assert.equal(deadlineIsForCurrentPhase(g), true, 'while still on that phase');

  g.season = 'fall'; // the board moves on
  assert.equal(deadlinePassed(g, o), true, 'the clock still says past...');
  assert.equal(deadlineIsForCurrentPhase(g), false, '...but the promise was spent');
});

test('a deadline with no phase stamp still resolves, deliberately', () => {
  // Games published before the stamp existed carry a deadline and no
  // deadlineFor, and must keep working; the other guards cover that case.
  const g = published({ deadline: PAST, deadlineFor: null });
  assert.equal(deadlineIsForCurrentPhase(g), true);

  assert.equal(deadlineIsForCurrentPhase(published({ deadline: null })), false);
});

// ---------------------------------------------------------------------------
// who may submit, and whose orders count
// ---------------------------------------------------------------------------

test('submissions are closed before a deadline is set and after it passes', () => {
  const o = snapshot();
  assert.equal(ordersOpen(published({ deadline: null }), o), false);
  assert.equal(ordersOpen(published({ deadline: PAST }), o), false);
  assert.equal(ordersOpen(published({ deadline: FUTURE }), o), true);
});

test('a comment edited after the deadline is void', () => {
  const g = published({ deadline: new Date(Date.now() - HOUR).toISOString() });
  const onTime = { updatedAt: new Date(Date.now() - 2 * HOUR).toISOString() };
  const late = { updatedAt: new Date(Date.now() - 1 * 60000).toISOString() };

  assert.equal(submissionOnTime(g, onTime), true);
  assert.equal(submissionOnTime(g, late), false);

  // an absent stamp means "unknown", resolved in the player's favour on
  // purpose rather than by silently falling back to created_at
  assert.equal(submissionOnTime(g, { updatedAt: null }), true);
  // and with no deadline at all nothing can be late
  assert.equal(submissionOnTime(published({ deadline: null }), late), true);
});

test('a late-resubmit authorization is scoped to one phase only', () => {
  const g = published({
    deadline: PAST,
    lateResubmit: { france: { year: 1901, season: 'spring', step: 'movement' } },
  });
  const o = snapshot();

  assert.equal(lateResubmitAllowed(g, 'france'), true);
  assert.equal(lateResubmitAllowed(g, 'england'), false, 'only the named power');
  assert.equal(isSubmitAllowed(g, o, 'france'), true, 'past the deadline, but allowed');
  assert.equal(isSubmitAllowed(g, o, 'england'), false);

  g.season = 'fall';
  assert.equal(lateResubmitAllowed(g, 'france'), false, 'never carries into the next phase');
  assert.equal(isSubmitAllowed(g, o, 'france'), false);
});

// ---------------------------------------------------------------------------
// what a submission is, and who may see it
// ---------------------------------------------------------------------------

test('a submission must match the phase, the power and the assigned login', () => {
  const g = published({ deadline: FUTURE });
  const o = snapshot({ comments: [submission('fra-player', 'france', 'A Par - Bur')] });

  assert.equal(phaseSubmission(g, o, 'france').submission.orders, 'A Par - Bur');
  assert.equal(phaseSubmission(g, o, 'england'), null, 'nothing from England');

  // the same comment left behind by the previous phase
  const stale = snapshot({
    comments: [submission('fra-player', 'france', 'A Par H', { phase: { season: 'fall' } })],
  });
  assert.equal(phaseSubmission(g, stale, 'france'), null);

  // a comment claiming a power its author was not assigned
  const wrongPower = snapshot({
    comments: [submission('fra-player', 'england', 'F Lon - ENG')],
  });
  assert.equal(phaseSubmission(g, wrongPower, 'england'), null, 'not England’s login');
});

test('a submission that will not unseal counts as absent, not as empty orders', () => {
  // A sealed blob nobody could open must read as "waiting" — never resolved or
  // published as a power that ordered nothing.
  const g = published({ deadline: FUTURE });
  const sealedOnly = {
    id: 'x', user: { login: 'fra-player' }, created_at: PAST, updated_at: FUTURE,
    body: submissionBody({
      power: 'france', year: 1901, season: 'spring', step: 'movement', sealed: 'BLOB',
    }),
  };
  const o = snapshot({ comments: [sealedOnly] });
  assert.equal(phaseSubmission(g, o, 'france'), null);
  assert.equal(powerOnlineStatus(g, o, 'france'), 'none');
});

test('mySubmission is my own comment for this phase', () => {
  const g = published({ deadline: FUTURE });
  const o = snapshot({
    login: 'fra-player',
    comments: [submission('fra-player', 'france', 'A Par - Bur')],
  });
  assert.equal(mySubmission(g, o, 'france').orders, 'A Par - Bur');
  assert.equal(mySubmission(g, o, 'england'), null, 'not the power I am playing');
  assert.equal(mySubmission(g, o, ''), null, 'a spectator has none');
  assert.equal(mySubmission(g, snapshot({ login: 'fra-player' }), 'france'), null, 'nothing fetched');
});

test('manual mode reveals nothing to anyone until the GM publishes', () => {
  // The whole point of the default mode: a typo caught before publishing costs
  // nothing, one caught after has already leaked information.
  const g = published({ deadline: PAST, publishMode: 'manual' });
  const o = snapshot({ comments: [submission('fra-player', 'france', 'A Par - Bur')] });

  assert.equal(revealedEntry(g, o, 'france'), null, 'deadline passed, still dark');
  assert.equal(powerOnlineStatus(g, o, 'france'), 'submitted');
});

test('auto mode reveals on-time submissions the moment the deadline passes', () => {
  const g = published({ deadline: PAST, publishMode: 'auto' });
  const o = snapshot({
    comments: [submission('fra-player', 'france', 'A Par - Bur', {
      updated_at: new Date(Date.parse(PAST) - HOUR).toISOString(),
    })],
  });

  assert.equal(revealedEntry(g, o, 'france').orders, 'A Par - Bur');
  assert.equal(powerOnlineStatus(g, o, 'france'), 'revealed');

  // ...but not before it passes
  const open = published({ deadline: FUTURE, publishMode: 'auto' });
  assert.equal(revealedEntry(open, o, 'france'), null);
  assert.equal(powerOnlineStatus(open, o, 'france'), 'submitted');
});

test('auto mode marks a late edit void rather than revealing it', () => {
  const g = published({ deadline: PAST, publishMode: 'auto' });
  const o = snapshot({ comments: [submission('fra-player', 'france', 'A Par - Bur', { updated_at: FUTURE })] });

  assert.equal(powerOnlineStatus(g, o, 'france'), 'late');
  assert.equal(revealedEntry(g, o, 'france'), null);
});

test('a published moves file outranks everything, in either mode', () => {
  const g = published({ deadline: PAST, publishMode: 'manual' });
  const o = snapshot({
    comments: [submission('fra-player', 'france', 'A Par - Bur')],
    moves: {
      france: {
        power: 'france',
        history: [{ year: 1901, season: 'spring', step: 'movement', orders: 'A Par H' }],
      },
    },
  });
  assert.equal(revealedEntry(g, o, 'france').orders, 'A Par H');
  assert.equal(powerOnlineStatus(g, o, 'france'), 'published');
});

test('powerOnlineStatus says "unknown" before anything is fetched', () => {
  const g = published({ deadline: FUTURE });
  assert.equal(powerOnlineStatus(g, snapshot(), 'france'), 'unknown');
  assert.equal(powerOnlineStatus(g, snapshot({ comments: [] }), 'france'), 'none');
});

// ---------------------------------------------------------------------------
// gathering the phase's orders — one loop, three sources
// ---------------------------------------------------------------------------

test('the "ontime" source is what auto-publish resolves, and it drops late edits', () => {
  const g = published({ deadline: PAST, publishMode: 'auto' });
  const early = new Date(Date.parse(PAST) - HOUR).toISOString();
  const o = snapshot({
    comments: [
      submission('fra-player', 'france', 'A Par - Bur', { updated_at: early }),
      submission('eng-player', 'england', 'F Lon - ENG', { updated_at: FUTURE }), // late
    ],
  });

  const { text, submitted } = gatherPhaseBlocks(g, o, 'ontime');
  assert.equal(submitted, 1);
  const by = splitOrdersByPower(text);
  assert.equal(blockBody(by, 'france'), 'A Par - Bur');
  assert.ok(!by.has('england'), 'a late edit is not resolved');
});

test('nobody submitting yields nothing to publish, which is what stands auto-publish down', () => {
  // An unattended whole-board all-hold is not a plausible turn — it is what
  // this class of bug looks like on the way out.
  const g = published({ deadline: PAST, publishMode: 'auto' });
  const { text, submitted } = gatherPhaseBlocks(g, snapshot({ comments: [] }), 'ontime');
  assert.equal(submitted, 0);
  assert.equal(text, '');
});

test('a power that deliberately submits only holds still counts', () => {
  // The test counts submissions, not moves: a power that said "everyone holds"
  // has said something, and that phase resolves normally.
  const g = published({ deadline: PAST, publishMode: 'auto' });
  const early = new Date(Date.parse(PAST) - HOUR).toISOString();
  const o = snapshot({ comments: [submission('fra-player', 'france', 'A Par H', { updated_at: early })] });
  assert.equal(gatherPhaseBlocks(g, o, 'ontime').submitted, 1);
});

test('the "gm" source keeps late submissions and blanks the rest', () => {
  // The GM loads everything they can see, on time or not, and amends in the
  // box before publishing — that is the one place a late grace is granted.
  const g = published({ deadline: PAST, publishMode: 'manual' });
  const o = snapshot({
    comments: [submission('eng-player', 'england', 'F Lon - ENG', { updated_at: FUTURE })],
  });
  const blanks = splitOrdersByPower(['FRANCE', '', 'ENGLAND', '', 'GERMANY', ''].join('\n'));

  const { text, submitted } = gatherPhaseBlocks(g, o, 'gm', blanks);
  const by = splitOrdersByPower(text);
  assert.equal(submitted, 1);
  assert.equal(blockBody(by, 'england'), 'F Lon - ENG', 'late, but the GM sees it');
  assert.ok(by.has('france'), 'and every other power gets a heading to fill in');
  assert.equal(blockBody(by, 'france'), '');
});

test('the "revealed" source is what a spectator is allowed to load', () => {
  const g = published({ deadline: PAST, publishMode: 'manual' });
  const o = snapshot({
    comments: [submission('fra-player', 'france', 'A Par - Bur')],
    moves: {
      england: {
        power: 'england',
        history: [{ year: 1901, season: 'spring', step: 'movement', orders: 'F Lon - ENG' }],
      },
    },
  });

  const by = splitOrdersByPower(gatherPhaseBlocks(g, o, 'revealed').text);
  assert.equal(blockBody(by, 'england'), 'F Lon - ENG', 'published, so visible');
  assert.ok(!by.has('france'), 'merely submitted, so not visible in manual mode');
});

// ---------------------------------------------------------------------------
// chaining the next deadline
// ---------------------------------------------------------------------------

test('a step counts from the previous deadline, not from the press', () => {
  const saturday = Date.parse('2026-09-05T00:00:00Z');
  const g = published({ deadline: new Date(saturday).toISOString() });
  assert.equal(deadlineChainBase(g), saturday);
  assert.equal(bumpTarget(g, snapshot(), 7 * 24), saturday + 7 * 24 * HOUR);
});

test('the rhythm survives the deadline being cleared on publish', () => {
  // Publishing clears game.deadline, so without lastDeadline the chain would
  // break at exactly the press that matters.
  const saturday = Date.parse('2026-09-05T00:00:00Z');
  const g = published({ deadline: null, lastDeadline: new Date(saturday).toISOString() });
  assert.equal(deadlineChainBase(g), saturday);
  assert.equal(bumpTarget(g, snapshot(), 7 * 24), saturday + 7 * 24 * HOUR);
});

test('only a game that never had a deadline counts from the clock', () => {
  const g = published({ deadline: null, lastDeadline: null });
  assert.equal(deadlineChainBase(g), null);
  const o = snapshot();
  const target = bumpTarget(g, o, 24);
  assert.ok(Math.abs(target - (trustedNow(o) + 24 * HOUR)) < 1000);
});

test('a step whose window has gone by is refused, and says both dates', () => {
  const fmtWhen = (ms) => new Date(ms).toISOString();
  const twoDaysAgo = new Date(Date.now() - 48 * HOUR).toISOString();
  const g = published({ deadline: twoDaysAgo });
  const o = snapshot();

  const reason = bumpUnavailableReason(g, o, 24, '+24 h', fmtWhen);
  assert.ok(reason, '+24 h from two days ago is already past');
  assert.match(reason, /already past/);
  assert.match(reason, /\+24 h/);

  assert.equal(bumpUnavailableReason(g, o, 7 * 24, '+1 week', fmtWhen), null, 'a longer step still works');
  // a game with no previous deadline counts from now, so nothing is unavailable
  assert.equal(
    bumpUnavailableReason(published({ deadline: null }), o, 24, '+24 h', fmtWhen),
    null
  );
});

// ---------------------------------------------------------------------------
// a viewer's board against the gist
// ---------------------------------------------------------------------------

test('viewerPosition ignores the GM’s private redo bookkeeping', () => {
  const a = newGame('g');
  const b = { ...newGame('g'), redoStack: [{ label: 'Spring 1901 — Movement' }] };
  assert.equal(viewerPosition(a), viewerPosition(b), 'redoStack is not a divergence');

  const moved = { ...newGame('g'), season: 'fall' };
  assert.notEqual(viewerPosition(a), viewerPosition(moved));

  // a board edit never touches history, and must still register
  const edited = newGame('g');
  edited.units = edited.units.slice(1);
  assert.notEqual(viewerPosition(a), viewerPosition(edited));
});

test('extendsOurHistory tells stepping forward from being overwritten', () => {
  const ours = { history: [{ label: 'Spring 1901' }] };
  const ahead = { history: [{ label: 'Spring 1901' }, { label: 'Fall 1901' }] };
  const rewritten = { history: [{ label: 'Spring 1901 (amended)' }, { label: 'Fall 1901' }] };

  assert.equal(extendsOurHistory(ours, ahead), true, 'step through the new phase');
  assert.equal(extendsOurHistory(ours, rewritten), false, 'the GM undid or amended: reload');
  assert.equal(extendsOurHistory(ours, ours), false, 'nothing new');
  assert.equal(extendsOurHistory(ahead, ours), false, 'the gist is behind us');
  assert.equal(extendsOurHistory({}, ahead), true, 'a viewer with no history yet');
});
