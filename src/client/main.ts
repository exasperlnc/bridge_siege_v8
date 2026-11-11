import './style.css';
import {
  type Action, type GameState, type Player, type PosId, type UnitType, EXTRA_DESTROY_AP, MAX_RECRUITS, MOVE,
  RECRUIT_COST, RETRAIN_COST, TOWER_AP, TOWER_DESTROY_AP, TOWER_TILES, UNIT_NAME, UNIT_TYPES, USE_COST,
  abilityTargets, applyAction, applyActions, castleOf, getUnit, isCastle, newGame, other, reachable, underSiege,
  unitAt,
} from '../engine/index.ts';
import type { SeatInfo, ServerMsg } from '../engine/protocol.ts';
import { BoardRenderer, type Mode, type View } from './render.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------- app state ----------------

type Session =
  | { kind: 'local' }
  | { kind: 'online'; ws: WebSocket | null; room: string; seat: Player | null; seats: (SeatInfo | null)[]; connected: boolean };

let session: Session | null = null;
let state: GameState | null = null;
let focusId: string | null = null;
let mode: Mode = 'move';
let hover: PosId | null = null;
let pending = false;
let mineCount = 1;

const canvas = $<HTMLCanvasElement>('board');
const renderer = new BoardRenderer(canvas);

const viewer = (): Player => (session?.kind === 'online' ? session.seat ?? 0 : state?.current ?? 0);

function canAct(): boolean {
  if (!state || state.winner !== null || pending) return false;
  if (session?.kind === 'online' && (!session.connected || session.seats.some((s) => !s))) return false;
  return state.current === viewer();
}

/** State as if the focused unit were selected (so we can show its options before spending AP). */
function preview(): { s: GameState | null; err: string | null } {
  if (!state || !focusId || !canAct()) return { s: null, err: null };
  const u = getUnit(state, focusId);
  if (!u || u.owner !== viewer()) return { s: null, err: null };
  if (state.active?.unitId === focusId) return { s: state, err: null };
  if (state.used.includes(focusId)) return { s: null, err: null };
  const r = applyAction(state, viewer(), { type: 'select', unitId: focusId });
  return r.ok ? { s: r.state, err: null } : { s: null, err: r.error };
}

// Memoize derived view data per (state, focus) so pointer moves are cheap.
let derivedKey: unknown[] = [];
let derived: ReturnType<typeof derive> | null = null;
function derive() {
  const p = preview();
  const reach = p.s ? reachable(p.s) : { paths: new Map(), builds: new Map() };
  const targets = p.s ? abilityTargets(p.s) : null;
  return { p, reach, targets };
}
function getDerived() {
  const key = [state, focusId, pending, session?.kind === 'online' ? session.connected : 1];
  if (!derived || key.some((k, i) => k !== derivedKey[i])) { derived = derive(); derivedKey = key; }
  return derived;
}

// ---------------- actions ----------------

function act(actions: Action[]) {
  if (!state || !canAct()) return;
  if (focusId && state.active?.unitId !== focusId && actions[0]?.type !== 'select' && needsUnit(actions[0])) {
    actions = [{ type: 'select', unitId: focusId }, ...actions];
  }
  if (session?.kind === 'local') {
    const r = applyActions(state, state.current, actions);
    if (!r.ok) return toast(r.error);
    setState(r.state);
  } else if (session?.kind === 'online' && session.ws) {
    // validate locally first for instant feedback
    const r = applyActions(state, viewer(), actions);
    if (!r.ok && !actions.some((a) => a.type === 'undo')) return toast(r.error);
    pending = true;
    session.ws.send(JSON.stringify({ t: 'act', actions }));
    render();
  }
  mode = 'move';
}
const needsUnit = (a?: Action) => !!a && !['mine', 'recruit', 'retrain', 'endTurn', 'resign', 'finish', 'undo'].includes(a.type);

function setState(s: GameState | null) {
  const prev = state;
  state = s;
  if (s) {
    if (focusId && !getUnit(s, focusId)) focusId = null;
    if (s.active) focusId = s.active.unitId;
    else if (prev?.active && !s.active && focusId === prev.active.unitId) focusId = null;
    if (s.current !== viewer() && session?.kind === 'online') { focusId = null; mode = 'move'; }
    if (session?.kind === 'local' && prev && prev.current !== s.current) { focusId = null; mode = 'move'; }
  }
  render();
}

// ---------------- input ----------------

function onTap(px: number, py: number) {
  if (!state) return;
  const hit = renderer.hit(px, py);
  if (!hit) return;
  const s = state;
  const me = viewer();
  const { p, reach, targets } = getDerived();

  // passenger badges are tappable to select a carried unit
  if (hit.kind === 'cell') {
    const pid = renderer.passengerHit(s, px, py);
    if (pid && getUnit(s, pid)?.owner === me) { focus(pid); return; }
  }

  if (mode !== 'move') {
    if (hit.kind === 'cell' && targets && currentTargets(targets).includes(hit.pos)) {
      const t = hit.pos;
      if (mode === 'destroyTile') act([{ type: 'destroyTile', target: t }]);
      else if (mode === 'destroyExtra') act([{ type: 'destroyExtra', target: t }]);
      else if (mode === 'destroyTower') act([{ type: 'destroyTower', target: t }]);
      else if (mode === 'dropoff') act([{ type: 'dropoff', target: t }]);
      return;
    }
    mode = 'move';
  }

  if (p.s && targets) {
    if (hit.kind === 'cell' && targets.attack.includes(hit.pos)) return act([{ type: 'attack', target: hit.pos }]);
    const dest = hit.kind === 'cell' ? hit.pos : hit.unitId ? null : castleOf(hit.owner);
    if (dest !== null && reach.paths.has(dest)) return act([{ type: 'move', path: reach.paths.get(dest)! }]);
  }

  if (hit.kind === 'castle') {
    if (hit.unitId) return focus(hit.unitId);
    return focus(null);
  }
  const u = unitAt(s, hit.pos);
  focus(u ? u.id : null);
}

function focus(id: string | null) {
  focusId = id;
  mode = 'move';
  render();
}

function currentTargets(t: NonNullable<ReturnType<typeof getDerived>['targets']>): PosId[] {
  switch (mode) {
    case 'destroyTile': return t.destroyTile;
    case 'destroyExtra': return t.destroyExtra;
    case 'destroyTower': return t.destroyTower;
    case 'dropoff': return t.dropoff;
    default: return [];
  }
}

let downAt: { x: number; y: number } | null = null;
canvas.addEventListener('pointerdown', (e) => { downAt = { x: e.offsetX, y: e.offsetY }; });
canvas.addEventListener('pointerup', (e) => {
  if (!downAt) return;
  if (Math.hypot(e.offsetX - downAt.x, e.offsetY - downAt.y) < 12) onTap(e.offsetX, e.offsetY);
  downAt = null;
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return;
  const h = renderer.hit(e.offsetX, e.offsetY);
  const pos = !h ? null : h.kind === 'cell' ? h.pos : h.unitId ? null : castleOf(h.owner);
  if (pos !== hover) { hover = pos; drawBoard(); }
});
canvas.addEventListener('pointerleave', () => { hover = null; drawBoard(); });

window.addEventListener('keydown', (e) => {
  if (!state || (e.target as HTMLElement).tagName === 'INPUT') return;
  if (e.key === 'Escape') { if (mode !== 'move') mode = 'move'; else focusId = state.active?.unitId ?? null; render(); }
  if ((e.key === 'z' && (e.metaKey || e.ctrlKey)) || e.key === 'u') { if (state.active) act([{ type: 'undo' }]); }
});

// ---------------- rendering ----------------

let raf = 0;
function render() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; renderHud(); renderPanel(); drawBoard(); renderOverlay(); });
}

function drawBoard() {
  if (!state) return;
  const { reach, targets } = getDerived();
  const v: View = {
    state, viewer: viewer(), focusId, canAct: canAct() && !!targets, mode,
    moves: reach.paths, builds: reach.builds, attack: targets?.attack ?? [],
    targets: targets ? currentTargets(targets) : [], hover,
  };
  renderer.draw(v);
}

const wrap = $('board-wrap');
new ResizeObserver(() => {
  renderer.fit(wrap.clientWidth - 8, wrap.clientHeight - 8);
  drawBoard();
}).observe(wrap);

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const dot = (p: Player, off = false) => `<span class="dot p${p}${off ? ' off' : ''}"></span>`;

function renderHud() {
  if (!state) return;
  const s = state;
  const parts: string[] = [];
  for (const p of [viewer(), other(viewer())] as Player[]) {
    const connected = session?.kind === 'online' ? session.seats[p]?.connected ?? false : true;
    const name = session?.kind === 'online' && !session.seats[p] ? 'Waiting…' : s.players[p].name;
    parts.push(`<span class="hud-player">${dot(p, !connected)}${esc(name)}${p === viewer() && session?.kind === 'online' ? ' <span class="hud-stat">(you)</span>' : ''}</span>
      <span class="hud-stat">tiles <b>${s.players[p].stockpile}</b></span>
      ${underSiege(s, p) ? '<span class="badge">SIEGE</span>' : ''}`);
    if (p === viewer()) parts.push('<span class="hud-stat">vs</span>');
  }
  if (session?.kind === 'online') parts.push(`<span class="spacer"></span><span class="hud-stat">Room <b class="room-code">${session.room}</b></span>${session.connected ? '' : '<span class="badge">OFFLINE</span>'}`);
  $('hud').innerHTML = parts.join('');
}

function renderPanel() {
  if (!state) return;
  const s = state;
  const me = viewer();
  const myTurn = s.current === me;
  const live = canAct();
  const ps = s.players[me];
  const html: string[] = [];
  const turnName = session?.kind === 'local' ? `${esc(s.players[s.current].name)}'s turn` : myTurn ? 'Your turn' : `${esc(s.players[s.current].name)}'s turn`;
  html.push(`<div class="turn"><h2>${dot(s.current)} ${turnName}</h2><div class="pips" title="${s.ap} AP left">${Array.from({ length: 8 }, (_, i) => `<span class="pip${i < s.ap ? ' full' : ''}"></span>`).join('')}</div></div>`);

  const { p, targets } = getDerived();
  const fu = focusId ? getUnit(s, focusId) : null;
  if (fu) {
    const isActive = s.active?.unitId === fu.id;
    const a = isActive ? s.active! : p.s?.active;
    const mine = fu.owner === me;
    const carried = fu.carriedBy ? 'being carried' : fu.carrying ? `carrying ${UNIT_NAME[getUnit(s, fu.carrying)!.type]}` : isCastle(fu.pos) ? 'in castle' : '';
    const status = !mine ? 'Enemy unit' : s.used.includes(fu.id) && !isActive ? 'Already used this turn' :
      a ? `Moves ${a.movementLeft}/${MOVE[fu.type]} · ability ${a.abilityUsed ? 'used' : 'ready'}` : `Move ${MOVE[fu.type]}`;
    html.push(`<div class="card"><h3>${dot(fu.owner)} ${UNIT_NAME[fu.type]}</h3><div class="meta">${status}${carried ? ` · ${carried}` : ''}</div>`);
    if (live && mine && targets && a) {
      if (!isActive) html.push(`<p class="hint">Move or use an ability to spend ${USE_COST} AP on this unit.${s.active ? ' This finalizes your current unit.' : ''}</p>`);
      const b: string[] = [];
      const mbtn = (m: Mode, label: string, enabled: boolean, cls = '') => b.push(`<button class="btn ${cls}${mode === m ? ' on' : ''}" data-mode="${m}" ${enabled ? '' : 'disabled'}>${label}</button>`);
      if (fu.type === 'builder') {
        mbtn('destroyTile', 'Destroy tile', targets.destroyTile.length > 0, 'warn');
        if (a.ability === 'destroyTile') mbtn('destroyExtra', `Extra tile (${EXTRA_DESTROY_AP} AP)`, targets.destroyExtra.length > 0, 'warn');
        mbtn('destroyTower', `Destroy tower (+${TOWER_DESTROY_AP} AP)`, targets.destroyTower.length > 0, 'warn');
        b.push(`<button class="btn" data-act="buildTower" ${targets.buildTower ? '' : 'disabled'} title="${esc(targets.why.buildTower ?? '')}">Build tower (+${TOWER_AP} AP, ${TOWER_TILES} tiles)</button>`);
        if (targets.destroyCastle) b.push(`<button class="btn danger" data-act="destroyCastle">Storm the castle!</button>`);
      }
      for (const pid of targets.pickup) {
        const pu = getUnit(s, pid)!;
        b.push(`<button class="btn" data-pickup="${pid}">Pick up ${fu.type === 'mount' ? UNIT_NAME[pu.type] : '(board mount)'}</button>`);
      }
      if (fu.carrying || fu.carriedBy) mbtn('dropoff', 'Drop off', targets.dropoff.length > 0);
      if (b.length) html.push(`<div class="btns">${b.join('')}</div>`);
      if (mode !== 'move') html.push('<p class="hint">Tap a highlighted tile. Tap elsewhere to cancel.</p>');
      else if (fu.type === 'seeker' && targets.attack.length) html.push('<p class="hint">Tap a red-ringed enemy to attack.</p>');
      if (fu.type === 'builder' && mode === 'move') html.push('<p class="hint">Yellow tiles build new bridge (1 tile each).</p>');
    } else if (live && mine && p.err) {
      html.push(`<p class="hint">${esc(p.err)}</p>`);
    }
    if (live && mine && isActive) {
      html.push(`<div class="btns"><button class="btn" data-act="undo">Undo</button><button class="btn primary" data-act="finish">Done with unit</button></div>`);
    }
    // retrain
    if (live && mine && fu.pos === castleOf(me) && !fu.carriedBy && !fu.carrying && !isActive) {
      const opts = UNIT_TYPES.filter((t) => t !== fu.type).map((t) =>
        `<button class="btn small" data-retrain="${t}" ${ps.pool[t] > 0 && s.ap >= RETRAIN_COST ? '' : 'disabled'}>${UNIT_NAME[t]} (${ps.pool[t]})</button>`).join('');
      html.push(`<p class="section-title">Retrain (${RETRAIN_COST} AP)</p><div class="btns">${opts}</div>`);
    }
    html.push('</div>');
  } else if (live) {
    html.push('<p class="hint">Tap one of your units to use it (2 AP). Units in your castle are in the strip at the bottom.</p>');
  }

  if (myTurn || session?.kind === 'local') {
    const sieged = underSiege(s, s.current);
    const cur = s.players[s.current];
    mineCount = Math.max(1, Math.min(mineCount, Math.max(1, s.ap)));
    html.push(`<div class="card"><p class="section-title">Castle actions${sieged ? ' · <span class="badge">UNDER SIEGE</span>' : ''}</p>
      <div class="row"><div class="stepper"><button class="btn small" data-mine="-1" ${live ? '' : 'disabled'}>−</button><span>${mineCount}</span><button class="btn small" data-mine="1" ${live ? '' : 'disabled'}>+</button></div>
      <button class="btn" style="flex:1" data-act="mine" ${live && !sieged && s.ap >= mineCount ? '' : 'disabled'}>Mine ${mineCount} tile${mineCount > 1 ? 's' : ''} (${mineCount} AP)</button></div>
      <p class="section-title">Recruit (${RECRUIT_COST} AP · ${MAX_RECRUITS - cur.recruitsUsed} left)</p>
      <div class="btns">${UNIT_TYPES.map((t: UnitType) => `<button class="btn small" data-recruit="${t}" ${live && !sieged && s.ap >= RECRUIT_COST && cur.pool[t] > 0 && cur.recruitsUsed < MAX_RECRUITS ? '' : 'disabled'}>${UNIT_NAME[t]} (${cur.pool[t]})</button>`).join('')}</div>
      </div>`);
    html.push(`<div class="btns endturn"><button class="btn primary big" data-act="endTurn" ${live ? '' : 'disabled'}>End turn</button></div>`);
  } else {
    html.push(`<p class="hint">Waiting for ${esc(s.players[s.current].name)}…</p>`);
  }

  const log = s.log.slice(-10).reverse().map((l) => `<li>${dot(l.player)}<span>${esc(l.text)}</span></li>`).join('');
  html.push(`<ul class="log">${log}</ul>`);
  html.push(`<div class="btns"><button class="btn small" data-act="resign">${session?.kind === 'local' ? 'Quit' : 'Resign'}</button></div>`);
  $('panel').innerHTML = html.join('');
}

$('panel').addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
  if (!el || el.disabled || !state) return;
  const d = el.dataset;
  if (d.mode) { mode = mode === d.mode ? 'move' : (d.mode as Mode); return render(); }
  if (d.mine) { mineCount += Number(d.mine); return render(); }
  if (d.pickup) return act([{ type: 'pickup', partnerId: d.pickup }]);
  if (d.recruit) return act([{ type: 'recruit', unitType: d.recruit as UnitType }]);
  if (d.retrain && focusId) return act([{ type: 'retrain', unitId: focusId, unitType: d.retrain as UnitType }]);
  switch (d.act) {
    case 'mine': return act([{ type: 'mine', count: mineCount }]);
    case 'buildTower': return act([{ type: 'buildTower' }]);
    case 'destroyCastle': return act([{ type: 'destroyCastle' }]);
    case 'undo': return act([{ type: 'undo' }]);
    case 'finish': act([{ type: 'finish' }]); focusId = null; return render();
    case 'endTurn': focusId = null; return act([{ type: 'endTurn' }]);
    case 'resign':
      if (session?.kind === 'local') { if (confirm('Quit this game?')) leave(); return; }
      if (confirm('Resign this game?')) sendRaw({ t: 'act', actions: [{ type: 'resign' }] });
      return;
  }
});

function renderOverlay() {
  const o = $('overlay');
  if (session?.kind === 'online' && session.seats.some((s) => !s) && session.seat !== null) {
    const link = `${location.origin}${location.pathname}?room=${session.room}`;
    o.innerHTML = `<div class="modal"><h2>Waiting for an opponent</h2><p class="hint">Share this code or link:</p><div class="code">${session.room}</div>
      <button class="btn primary" id="copy">Copy invite link</button><button class="btn" id="leave">Leave</button></div>`;
    o.hidden = false;
    $('copy').onclick = () => { navigator.clipboard?.writeText(link).then(() => toast('Link copied', true), () => toast(link, true)); };
    $('leave').onclick = leave;
    return;
  }
  if (state?.winner !== null && state) {
    const me = viewer();
    const title = session?.kind === 'local' ? `${esc(state.players[state.winner].name)} wins!` : state.winner === me ? 'Victory!' : 'Defeat';
    o.innerHTML = `<div class="modal"><h2>${dot(state.winner)} ${title}</h2><p class="hint">${esc(state.winReason ?? '')}</p>
      <button class="btn primary big" id="again">Play again</button><button class="btn" id="leave">Leave</button></div>`;
    o.hidden = false;
    $('again').onclick = () => {
      if (session?.kind === 'local') setState(newGame(['Player 1', 'Player 2'], other(state!.winner!)));
      else sendRaw({ t: 'rematch' });
    };
    $('leave').onclick = leave;
    return;
  }
  o.hidden = true;
  o.innerHTML = '';
}

let toastTimer = 0;
function toast(msg: string, info = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `show${info ? ' info' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.className = ''), 2600);
}

// ---------------- networking ----------------

const TOKEN_KEY = (room: string) => `bs8:token:${room}`;
let reconnectDelay = 500;

function sendRaw(m: unknown) {
  if (session?.kind === 'online' && session.ws?.readyState === WebSocket.OPEN) session.ws.send(JSON.stringify(m));
}

function connect(first: { t: 'create'; name: string } | { t: 'join'; room: string; name: string }) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  if (session?.kind !== 'online') session = { kind: 'online', ws, room: first.t === 'join' ? first.room : '', seat: null, seats: [null, null], connected: false };
  else session.ws = ws;
  ws.onopen = () => {
    reconnectDelay = 500;
    const sess = session as Extract<Session, { kind: 'online' }>;
    sess.connected = true;
    if (first.t === 'join') ws.send(JSON.stringify({ ...first, token: localStorage.getItem(TOKEN_KEY(first.room)) ?? undefined }));
    else ws.send(JSON.stringify(first));
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data) as ServerMsg;
    const sess = session;
    if (sess?.kind !== 'online' || sess.ws !== ws) return;
    if (m.t === 'joined') {
      sess.room = m.room;
      sess.seat = m.seat;
      try { localStorage.setItem(TOKEN_KEY(m.room), m.token); } catch { /* storage unavailable */ }
      history.replaceState(null, '', `?room=${m.room}`);
      showGame();
    } else if (m.t === 'room') {
      sess.seats = m.seats;
      pending = false;
      setState(m.state ?? placeholderState(m.seats));
    } else if (m.t === 'error') {
      pending = false;
      if (sess.seat === null) { showLobbyError(m.msg); ws.close(); session = null; return; }
      toast(m.msg);
      render();
    }
  };
  ws.onclose = () => {
    const sess = session;
    if (sess?.kind !== 'online' || sess.ws !== ws) return;
    sess.connected = false;
    pending = false;
    render();
    if (sess.seat === null) return;
    setTimeout(() => { if (session === sess) connect({ t: 'join', room: sess.room, name: getName() }); }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 8000);
  };
}

function placeholderState(seats: (SeatInfo | null)[]): GameState {
  return newGame([seats[0]?.name ?? 'Player 1', seats[1]?.name ?? 'Waiting…']);
}

// ---------------- screens ----------------

function getName() {
  const n = $<HTMLInputElement>('name').value.trim();
  try { localStorage.setItem('bs8:name', n); } catch { /* ignore */ }
  return n;
}

function showGame() {
  $('lobby').hidden = true;
  $('game').hidden = false;
  requestAnimationFrame(() => { renderer.fit(wrap.clientWidth - 8, wrap.clientHeight - 8); render(); });
}

function leave() {
  if (session?.kind === 'online') { const ws = session.ws; session = null; ws?.close(); }
  session = null;
  state = null;
  focusId = null;
  history.replaceState(null, '', location.pathname);
  $('overlay').hidden = true;
  $('game').hidden = true;
  $('lobby').hidden = false;
}

function showLobbyError(msg: string) {
  $('lobby-error').textContent = msg;
  leave();
  $('lobby-error').textContent = msg;
}

try { $<HTMLInputElement>('name').value = localStorage.getItem('bs8:name') ?? ''; } catch { /* ignore */ }

$('create').onclick = () => { $('lobby-error').textContent = ''; connect({ t: 'create', name: getName() }); };
$('join').onclick = () => {
  const code = $<HTMLInputElement>('code').value.trim().toUpperCase();
  if (!code) return showLobbyError('Enter a room code.');
  $('lobby-error').textContent = '';
  connect({ t: 'join', room: code, name: getName() });
};
$('code').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') $('join').click(); });
$('local').onclick = () => {
  session = { kind: 'local' };
  showGame();
  setState(newGame(['Player 1', 'Player 2']));
};

const roomParam = new URLSearchParams(location.search).get('room');
if (roomParam) {
  $<HTMLInputElement>('code').value = roomParam.toUpperCase();
  if (localStorage.getItem(TOKEN_KEY(roomParam.toUpperCase()))) connect({ t: 'join', room: roomParam.toUpperCase(), name: getName() });
}

// keep the connection warm through proxies
setInterval(() => sendRaw({ t: 'ping' }), 25000);
