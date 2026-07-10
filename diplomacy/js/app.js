import { Board, POWER_COLORS } from './render.js';
import * as S from './state.js';
import { parseOrders } from './parser.js';
import { prov } from './adjudicator.js';
import { PROVINCES, POWERS } from './map-data.js';

const $ = (id) => document.getElementById(id);

let board;
let game = null;
let playback = null; // {entry, step, orders, readonly}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function provName(p) {
  return PROVINCES[prov(p)] ? PROVINCES[prov(p)].name : p;
}

function fmtLoc(l) {
  const c = l.includes('/') ? `(${l.split('/')[1]})` : '';
  return provName(l) + c;
}

function fmtOrder(o) {
  const t = o.unitType ? o.unitType + ' ' : '';
  const u = `${t}${fmtLoc(o.loc || '')}`;
  switch (o.kind) {
    case 'move': return `${u} → ${fmtLoc(o.dest)}${o.isConvoyMove ? ' ⚓' : ''}`;
    case 'retreat': return `${u} retreats → ${fmtLoc(o.dest)}`;
    case 'hold': return `${u} holds`;
    case 'disband': return `${u} disbands`;
    case 'support':
      return o.target.dest
        ? `${u} S ${fmtLoc(o.target.loc)} → ${fmtLoc(o.target.dest)}`
        : `${u} S ${fmtLoc(o.target.loc)} (hold)`;
    case 'convoy': return `${u} C ${fmtLoc(o.target.loc)} → ${fmtLoc(o.dest)}`;
    case 'build': return `build ${o.unitType} ${fmtLoc(o.loc)}`;
    case 'remove': return `remove ${fmtLoc(o.loc)}`;
    case 'waive': return `waive build`;
  }
  return '?';
}

function phaseKind() {
  return game.step === 'movement' ? 'movement' : game.step === 'retreat' ? 'retreat' : 'adjustment';
}

function showScreen(id) {
  $('home-screen').hidden = id !== 'home-screen';
  $('game-screen').hidden = id !== 'game-screen';
}

// ---------------------------------------------------------------------------
// home screen
// ---------------------------------------------------------------------------
function renderHome() {
  const list = $('game-list');
  list.replaceChildren();
  const games = S.listGames();
  const names = Object.keys(games).sort();
  if (!names.length) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="meta">No saved games yet</span>';
    list.appendChild(li);
  }
  for (const name of names) {
    const g = games[name];
    const li = document.createElement('li');
    const load = document.createElement('button');
    load.className = 'load';
    load.innerHTML = `${name} <span class="meta">· ${S.phaseLabel(g)}</span>`;
    load.onclick = () => openGame(g);
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '🗑';
    del.title = 'Delete';
    del.onclick = () => {
      if (confirm(`Delete "${name}"?`)) {
        S.deleteGame(name);
        renderHome();
      }
    };
    li.append(load, del);
    list.appendChild(li);
  }
}

function uniqueName(base) {
  const games = S.listGames();
  let name = base || 'Game';
  let n = 2;
  while (games[name]) name = `${base} ${n++}`;
  return name;
}

// ---------------------------------------------------------------------------
// game screen
// ---------------------------------------------------------------------------
function openGame(g) {
  game = g;
  playback = null;
  S.saveGame(game);
  showScreen('game-screen');
  $('game-name').textContent = game.name;
  $('sandbox-tools').open = !!game.sandbox && game.units.length === 0;
  refreshAll();
}

function refreshAll() {
  $('phase-label').textContent = S.phaseLabel(game);
  board.setPhaseText(S.phaseLabel(game));
  board.setInfluence(game.scOwners);
  board.setUnits(game.units, game.step === 'retreat' ? game.pending.dislodged : []);
  board.clearOrders();
  $('panel-playback').hidden = true;
  $('panel-orders').hidden = false;
  prefillOrders();
  renderHistorySelect();
  updateParseStatus();
}

function prefillOrders() {
  const ta = $('orders-text');
  const info = $('phase-info');
  if (game.step === 'movement') {
    $('orders-title').textContent = 'Orders — ' + S.phaseLabel(game);
    info.textContent = 'One order per line. Unordered units hold.';
    const lines = [];
    for (const p of POWERS) {
      const mine = game.units.filter((u) => u.power === p);
      if (!mine.length) continue;
      lines.push(p.toUpperCase());
      for (const u of mine) lines.push(`${u.type} ${u.loc} H`);
      lines.push('');
    }
    ta.value = lines.join('\n');
  } else if (game.step === 'retreat') {
    $('orders-title').textContent = 'Retreats — ' + S.phaseLabel(game);
    info.textContent = 'Dislodged units must retreat or disband. Unordered units disband.';
    const lines = [];
    for (const d of game.pending.dislodged) {
      lines.push(`${d.unit.power.toUpperCase()}`);
      lines.push(`${d.unit.type} ${prov(d.from)} disband   # options: ${d.retreatOptions.join(', ') || 'none'}`);
      lines.push('');
    }
    ta.value = lines.join('\n');
  } else {
    $('orders-title').textContent = 'Builds — ' + S.phaseLabel(game);
    const counts = S.adjustmentCounts(game);
    const occupied = new Set(game.units.map((u) => prov(u.loc)));
    const lines = [];
    const infoLines = [];
    for (const [p, c] of Object.entries(counts)) {
      if (c > 0) {
        const free = (S.HOME_CENTERS[p] || []).filter(
          (h) => game.scOwners[h] === p && !occupied.has(h)
        );
        infoLines.push(`${cap(p)}: ${c} build${c > 1 ? 's' : ''} (home centers free: ${free.join(', ') || 'none'})`);
        lines.push(p.toUpperCase(), ...free.slice(0, c).map((h) => `build A ${h}`), '');
      } else if (c < 0) {
        infoLines.push(`${cap(p)}: must disband ${-c}`);
        lines.push(p.toUpperCase(), `# remove <province>  — must disband ${-c}`, '');
      }
    }
    info.textContent = infoLines.join('\n') || 'No builds or disbands required.';
    ta.value = lines.join('\n');
  }
}

function updateParseStatus() {
  const { orders, errors } = parseOrders($('orders-text').value, phaseKind());
  const el = $('parse-status');
  if (errors.length) {
    el.innerHTML = `<span class="err">${errors.length} problem${errors.length > 1 ? 's' : ''}:\n` +
      errors.map((e) => '· ' + escapeHtml(e)).join('\n') + '</span>';
  } else {
    el.innerHTML = `<span class="ok">${orders.length} orders parsed ✓</span>`;
  }
  return { orders, errors };
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

// ---------------------------------------------------------------------------
// resolve + playback
// ---------------------------------------------------------------------------
function resolveCurrent() {
  const { orders, errors } = updateParseStatus();
  if (errors.length) return;
  const text = $('orders-text').value;
  const entry = S.resolvePhase(game, orders, text);
  S.saveGame(game);
  startPlayback(entry, false);
}

function playbackOrders(entry) {
  // explicit orders only, grouped by power for narration
  const res = entry.results.filter((r) => !r.order.implicit);
  const byPower = new Map();
  for (const r of res) {
    if (!byPower.has(r.order.power)) byPower.set(r.order.power, []);
    byPower.get(r.order.power).push(r);
  }
  return [...byPower.values()].flat();
}

function startPlayback(entry, readonly) {
  playback = { entry, readonly, orders: playbackOrders(entry), step: 0 };
  $('panel-orders').hidden = true;
  $('panel-playback').hidden = false;
  $('playback-title').textContent = entry.label;
  $('pb-continue').hidden = readonly;
  $('pb-back-current').hidden = !readonly;
  const list = $('pb-order-list');
  list.replaceChildren();
  for (const r of playback.orders) {
    const li = document.createElement('li');
    li.textContent = `${cap(r.order.power)}: ${fmtOrder(r.order)}`;
    li.style.listStyle = 'none';
    li.style.borderLeft = `4px solid ${POWER_COLORS[r.order.power] || '#888'}`;
    li.style.paddingLeft = '6px';
    list.appendChild(li);
  }
  playback.step = playback.orders.length ? 0 : outcomeStep();
  renderPlayback();
}

const outcomeStep = () => playback.orders.length;
const finalStep = () => playback.orders.length + 1;

function renderPlayback() {
  const { entry, step, orders } = playback;
  const isAdjustment = entry.step === 'adjustment';
  board.clearOrders();
  board.setPhaseText(entry.label);

  if (step >= finalStep()) {
    // clean final state
    board.setInfluence(entry.scOwnersAfter);
    board.setUnits(entry.unitsAfter, entry.dislodged && entry.step === 'movement'
      ? entry.dislodged.filter((d) => d.retreatOptions && d.retreatOptions.length)
      : []);
    $('pb-step-label').textContent = `Final positions → ${entry.phaseAfter}`;
  } else {
    board.setInfluence(entry.scOwnersBefore);
    board.setUnits(entry.unitsBefore, entry.step === 'retreat' ? entry.dislodged : []);
    // overlays for revealed orders
    for (let i = 0; i < Math.min(step, orders.length); i++) {
      drawPlaybackOrder(orders[i], isAdjustment);
    }
    if (step >= outcomeStep()) {
      // outcome marks
      for (const r of entry.results) {
        if (r.order.implicit && r.verdict !== 'fails') continue;
        if (r.verdict === 'fails' || r.verdict === 'invalid') {
          if (!r.order.implicit) board.markFailure(r.order, r.reason);
        }
      }
      if (entry.step === 'movement' && entry.dislodged) {
        board.setUnits(entry.unitsBefore.filter(
          (u) => !entry.dislodged.some((d) => prov(d.from) === prov(u.loc) && d.unit.power === u.power)
        ), entry.dislodged);
      }
      $('pb-step-label').textContent = 'Resolution! ✓ = success, ✕ = failed';
    } else {
      const r = orders[step - 1];
      $('pb-step-label').textContent = step === 0
        ? 'Board before orders — step through with ▶'
        : `${cap(r.order.power)}: ${fmtOrder(r.order)}`;
    }
  }

  // list highlighting
  const items = $('pb-order-list').children;
  for (let i = 0; i < items.length; i++) {
    const r = orders[i];
    items[i].className = '';
    if (i < step) items[i].classList.add('shown');
    if (i === step - 1 && step <= outcomeStep()) items[i].classList.add('current');
    if (step >= outcomeStep()) {
      items[i].classList.add(
        r.verdict === 'succeeds' ? 'ok' : r.verdict === 'invalid' ? 'invalid' : 'fail'
      );
      items[i].title = r.reason || '';
    }
  }
  $('pb-prev').disabled = step === 0;
  $('pb-next').disabled = step >= finalStep();
}

function drawPlaybackOrder(r, isAdjustment) {
  const o = r.order;
  const color = POWER_COLORS[o.power] || '#888';
  if (isAdjustment) {
    if (o.kind === 'build' || o.kind === 'remove') {
      const c = board.center(o.loc);
      const g = board._text(c.x, c.y - 20, o.kind === 'build' ? `+${o.unitType}` : '−1', 34,
        o.kind === 'build' ? '#2e8b57' : '#c40000');
      g.setAttribute('data-order-overlay', '1');
      board.layers.highest.appendChild(g);
    }
    return;
  }
  board.drawOrder(o, color);
}

function stepPlayback(delta) {
  if (!playback) return;
  const max = finalStep();
  playback.step = Math.max(0, Math.min(max, playback.step + delta));
  renderPlayback();
}

function endPlayback() {
  if (playback && playback.readonly) {
    playback = null;
    refreshAll();
  } else {
    playback = null;
    refreshAll();
  }
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------
function renderHistorySelect() {
  const sel = $('history-select');
  sel.replaceChildren();
  if (!game.history.length) {
    const opt = document.createElement('option');
    opt.textContent = '(no resolved turns yet)';
    sel.appendChild(opt);
    sel.disabled = true;
    $('btn-replay').disabled = true;
    $('btn-branch').disabled = true;
    return;
  }
  sel.disabled = false;
  $('btn-replay').disabled = false;
  $('btn-branch').disabled = false;
  game.history.forEach((h, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = h.label;
    sel.appendChild(opt);
  });
  sel.selectedIndex = game.history.length - 1;
}

function replaySelected() {
  const i = +$('history-select').value;
  const entry = game.history[i];
  if (entry) startPlayback(entry, true);
}

function branchSelected() {
  const i = +$('history-select').value;
  const entry = game.history[i];
  if (!entry) return;
  const name = prompt('Name for the practice branch:', uniqueName(`${game.name} @ ${entry.label}`));
  if (!name) return;
  const g = {
    ...S.newGame(uniqueName(name)),
    season: entry.season,
    year: entry.year,
    step: entry.step,
    units: structuredClone(entry.unitsBefore),
    scOwners: structuredClone(entry.scOwnersBefore),
    pending: structuredClone(entry.pendingBefore),
    sandbox: true,
  };
  g.name = uniqueName(name);
  openGame(g);
}

// ---------------------------------------------------------------------------
// sandbox editing
// ---------------------------------------------------------------------------
function sandboxClick(p) {
  if (!$('sandbox-tools').open || playback) return;
  const tool = $('sb-tool').value;
  const power = $('sb-power').value;
  const info = PROVINCES[p];
  if (!info) return;
  const at = game.units.findIndex((u) => prov(u.loc) === p);
  if (tool === 'erase') {
    if (at >= 0) game.units.splice(at, 1);
  } else if (tool === 'A') {
    if (info.type === 'water') return;
    if (at >= 0) game.units.splice(at, 1);
    game.units.push({ power, type: 'A', loc: p });
  } else if (tool === 'F') {
    if (info.type === 'land') return;
    let loc = p;
    if (info.coasts.length) {
      // cycle coasts on repeated clicks
      const existing = at >= 0 ? game.units[at] : null;
      const seq = info.coasts.map((c) => `${p}/${c}`);
      if (existing && existing.type === 'F' && existing.power === power) {
        const idx = seq.indexOf(existing.loc);
        loc = seq[(idx + 1) % seq.length];
      } else loc = seq[0];
    }
    if (at >= 0) game.units.splice(at, 1);
    game.units.push({ power, type: 'F', loc });
  } else if (tool === 'sc') {
    if (info.sc) game.scOwners[p] = power;
  } else if (tool === 'unsc') {
    if (info.sc) game.scOwners[p] = null;
  }
  S.saveGame(game);
  board.setInfluence(game.scOwners);
  board.setUnits(game.units, game.step === 'retreat' && game.pending ? game.pending.dislodged : []);
  prefillOrders();
  updateParseStatus();
}

// ---------------------------------------------------------------------------
// import/export
// ---------------------------------------------------------------------------
function exportCurrent() {
  const blob = new Blob([S.exportGame(game)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${game.name.replace(/[^\w-]+/g, '_')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importFile(file) {
  try {
    const g = S.importGame(await file.text());
    g.name = uniqueName(g.name || 'Imported game');
    openGame(g);
  } catch (e) {
    alert('Could not import: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
async function init() {
  board = await new Board().load($('board'));

  board.onProvinceClick = (p) => sandboxClick(p);
  board.onProvinceHover = (p) => {
    if (!p || !game) {
      $('hover-info').textContent = '';
      return;
    }
    const base = prov(p);
    const u = game.units.find((x) => prov(x.loc) === base);
    const owner = game.scOwners[base];
    $('hover-info').textContent =
      `${provName(p)}${PROVINCES[base].sc ? ' ⭐' : ''}` +
      (owner ? ` (${cap(owner)})` : '') +
      (u ? ` — ${u.type === 'A' ? 'Army' : 'Fleet'} ${cap(u.power)}` : '');
  };

  for (const p of POWERS) {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = cap(p);
    $('sb-power').appendChild(opt);
  }

  $('btn-new').onclick = () => openGame(S.newGame(uniqueName($('new-name').value.trim() || 'Game')));
  $('btn-sandbox').onclick = () => openGame(S.sandboxGame(uniqueName(($('new-name').value.trim() || 'Sandbox'))));
  $('import-file').onchange = (e) => e.target.files[0] && importFile(e.target.files[0]);
  $('btn-home').onclick = () => {
    playback = null;
    renderHome();
    showScreen('home-screen');
  };
  $('btn-export').onclick = exportCurrent;

  $('orders-text').addEventListener('input', updateParseStatus);
  $('btn-resolve').onclick = resolveCurrent;
  $('btn-preview').onclick = () => {
    const { orders } = updateParseStatus();
    board.clearOrders();
    for (const o of orders) board.drawOrder(o, POWER_COLORS[o.power] || '#888');
  };

  $('pb-next').onclick = () => stepPlayback(1);
  $('pb-prev').onclick = () => stepPlayback(-1);
  $('pb-start').onclick = () => stepPlayback(-999);
  $('pb-end').onclick = () => stepPlayback(999);
  $('pb-continue').onclick = endPlayback;
  $('pb-back-current').onclick = endPlayback;
  document.addEventListener('keydown', (e) => {
    if (playback && !$('panel-playback').hidden) {
      if (e.key === 'ArrowRight') stepPlayback(1);
      if (e.key === 'ArrowLeft') stepPlayback(-1);
    }
  });

  $('btn-replay').onclick = replaySelected;
  $('btn-branch').onclick = branchSelected;
  $('sb-apply').onclick = () => {
    game.season = $('sb-season').value;
    game.year = +$('sb-year').value || 1901;
    game.step = 'movement';
    game.pending = null;
    S.saveGame(game);
    refreshAll();
  };

  renderHome();
  showScreen('home-screen');
  autotest();
}

// Scripted flow for headless screenshot checks: index.html?autotest=<stage>
// stages: board | preview | mid | outcome | final
function autotest() {
  const stage = new URLSearchParams(location.search).get('autotest');
  if (!stage) return;
  localStorage.clear();
  openGame(S.newGame('Autotest'));
  const orders = [
    'ENGLAND', 'F lon - eng', 'A lvp - yor', 'F edi - nth', '',
    'FRANCE', 'A par - bur', 'A mar S A par - bur', 'F bre - mao', '',
    'GERMANY', 'A mun - bur', 'A ber - kie', 'F kie - den', '',
    'RUSSIA', 'A mos - ukr', 'F sev - bla', 'A war - gal', 'F stp/sc - bot', '',
    'TURKEY', 'F ank - bla', 'A con - bul', 'A smy - con', '',
    'AUSTRIA', 'A vie - gal', 'A bud - ser', 'F tri - alb', '',
    'ITALY', 'A ven - pie', 'A rom - ven', 'F nap - ion',
  ].join('\n');
  if (stage === 'board') return done();
  $('orders-text').value = orders;
  updateParseStatus();
  if (stage === 'preview') {
    $('btn-preview').click();
    return done();
  }
  resolveCurrent();
  if (stage === 'mid') {
    stepPlayback(1); stepPlayback(1); stepPlayback(1); stepPlayback(1); stepPlayback(1);
  } else if (stage === 'outcome') {
    stepPlayback(999); stepPlayback(-1);
  } else if (stage === 'final') {
    stepPlayback(999);
  }
  done();
  function done() {
    document.body.dataset.autotestDone = '1';
  }
}

// top-level await: the page's load event (and headless screenshots) wait for
// the board to be ready
await init();
