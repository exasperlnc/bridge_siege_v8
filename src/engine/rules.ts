// Pure, deterministic rules engine. applyAction never mutates its input.
import {
  type Action, type ActiveUse, type GameState, type Player, type PosId, type Result, type Unit, type UnitType,
  AP_PER_TURN, BRIDGE, FIRST_TURN_AP, EMPTY, EXTRA_DESTROY_AP, GATE_COLS, H, MAX_RECRUITS, MOVE, NCELLS, RECRUIT_COST,
  RETRAIN_COST, SIEGE_ROWS, START, START_STOCKPILE, TOTAL, TOWER_AP, TOWER_DESTROY_AP, TOWER_TILES, UNIT_TYPES,
  USE_COST, W, castleOf, castleOwner, cellAt, cellY, isCastle, isTower, other, towerValue,
} from './types.ts';

// ---------- board geometry ----------

export const gateCells = (p: Player): PosId[] => GATE_COLS.map((x) => cellAt(x, p === 0 ? H - 1 : 0));

/** -1 if not a gate cell, otherwise the owning player. */
export const GATE_OWNER: Int8Array = (() => {
  const g = new Int8Array(NCELLS).fill(-1);
  for (const p of [0, 1] as Player[]) for (const c of gateCells(p)) g[c] = p;
  return g;
})();

/** Orthogonal neighbors of each board cell. */
export const CELL_NB: PosId[][] = Array.from({ length: NCELLS }, (_, i) => {
  const x = i % W, y = Math.floor(i / W);
  const r: PosId[] = [];
  if (y > 0) r.push(i - W);
  if (y < H - 1) r.push(i + W);
  if (x > 0) r.push(i - 1);
  if (x < W - 1) r.push(i + 1);
  return r;
});

/** Spaces a unit owned by `owner` could step to from `pos` (ignoring occupancy and terrain). */
export function neighbors(s: GameState, pos: PosId, owner: Player): PosId[] {
  if (isCastle(pos)) {
    const p = castleOwner(pos);
    const r = gateCells(p);
    if (p === owner) {
      const tv = towerValue(p);
      for (let i = 0; i < NCELLS; i++) if (s.cells[i] === tv) r.push(i);
    }
    return r;
  }
  const r = CELL_NB[pos].slice();
  const ownCastleLink = GATE_OWNER[pos] === owner || s.cells[pos] === towerValue(owner);
  if (ownCastleLink) r.push(castleOf(owner));
  return r;
}

export const inSiegeZone = (p: Player, y: number) => (p === 0 ? y >= H - SIEGE_ROWS : y < SIEGE_ROWS);

export function underSiege(s: GameState, p: Player): boolean {
  return s.units.some((u) => u.owner !== p && !isCastle(u.pos) && inSiegeZone(p, cellY(u.pos)));
}

/** Cells that trace a path of tiles back to either castle's gate. Towers pass connection through. */
export function supportedCells(cells: number[]): Uint8Array {
  const sup = new Uint8Array(NCELLS);
  const queue: PosId[] = [];
  for (const p of [0, 1] as Player[])
    for (const g of gateCells(p)) if (cells[g] !== EMPTY && !sup[g]) { sup[g] = 1; queue.push(g); }
  while (queue.length) {
    const c = queue.pop()!;
    for (const n of CELL_NB[c]) if (!sup[n] && cells[n] !== EMPTY) { sup[n] = 1; queue.push(n); }
  }
  return sup;
}

// ---------- lookups ----------

export const getUnit = (s: GameState, id: string) => s.units.find((u) => u.id === id);
/** The (non-carried) unit standing on a board cell. */
export const unitAt = (s: GameState, pos: PosId) => s.units.find((u) => u.pos === pos && !u.carriedBy);

export function inPlayCount(s: GameState, p: Player, t: UnitType) {
  return s.units.filter((u) => u.owner === p && u.type === t).length;
}

/** Pieces of a type that can still be recruited or retrained into: destroyed pieces become available again. */
export function available(s: GameState, p: Player, t: UnitType) {
  return TOTAL[t] - inPlayCount(s, p, t);
}

export const UNIT_NAME: Record<UnitType, string> = { builder: 'Builder', seeker: 'Seeker', defender: 'Defender', mount: 'Mount' };

// ---------- setup ----------

export function newGame(names: [string, string] = ['Player 1', 'Player 2'], first: Player = 0): GameState {
  const s: GameState = {
    cells: new Array(NCELLS).fill(EMPTY),
    units: [],
    players: [0, 1].map((p) => ({
      name: names[p],
      stockpile: START_STOCKPILE,
      recruitsUsed: 0,
      lost: Object.fromEntries(UNIT_TYPES.map((t) => [t, 0])) as Record<UnitType, number>,
    })) as GameState['players'],
    current: first,
    ap: FIRST_TURN_AP,
    turn: 1,
    used: [],
    active: null,
    undo: [],
    winner: null,
    winReason: null,
    nextId: 1,
    log: [],
  };
  for (const p of [0, 1] as Player[])
    for (const t of UNIT_TYPES) for (let i = 0; i < START[t]; i++) addUnit(s, p, t);
  return s;
}

function addUnit(s: GameState, p: Player, t: UnitType): Unit {
  const u: Unit = { id: `u${s.nextId++}`, owner: p, type: t, pos: castleOf(p), carriedBy: null, carrying: null };
  s.units.push(u);
  return u;
}

// ---------- internal helpers ----------

function log(s: GameState, text: string) {
  s.log.push({ turn: s.turn, player: s.current, text });
  if (s.log.length > 60) s.log.splice(0, s.log.length - 60);
}

function snapshot(s: GameState) {
  const { undo: _undo, ...rest } = s;
  s.undo.push(JSON.stringify(rest));
}

function restore(s: GameState) {
  const rest = JSON.parse(s.undo.pop()!);
  Object.assign(s, rest);
}

function killUnit(s: GameState, u: Unit) {
  const victims = [u];
  if (u.carrying) { const p = getUnit(s, u.carrying); if (p) victims.push(p); }
  for (const v of victims) {
    s.players[v.owner].lost[v.type]++;
    s.units.splice(s.units.indexOf(v), 1);
  }
  return victims;
}

/** Remove all plain bridge tiles without a connection to a castle, plus units standing on them. */
function collapse(s: GameState): { tiles: number; units: Unit[] } {
  const sup = supportedCells(s.cells);
  let tiles = 0;
  const units: Unit[] = [];
  for (let i = 0; i < NCELLS; i++) {
    if (s.cells[i] === BRIDGE && !sup[i]) {
      s.cells[i] = EMPTY;
      tiles++;
      const u = unitAt(s, i);
      if (u) units.push(...killUnit(s, u));
    }
  }
  return { tiles, units };
}

function describeCollapse(c: { tiles: number; units: Unit[] }) {
  if (!c.tiles) return '';
  let t = ` ${c.tiles} unsupported tile${c.tiles > 1 ? 's' : ''} fell`;
  if (c.units.length) t += `, taking ${c.units.map((u) => UNIT_NAME[u.type]).join(', ')} with ${c.units.length > 1 ? 'them' : 'it'}`;
  return t + '.';
}

function checkSiegeWin(s: GameState) {
  for (const p of [other(s.current), s.current]) {
    if (underSiege(s, p) && !s.units.some((u) => u.owner === p)) {
      s.winner = other(p);
      s.winReason = `${s.players[p].name} was overrun while under siege.`;
      return;
    }
  }
}

/** Finalize the current unit use. Returns an error if its end state is illegal. */
function commit(s: GameState): string | null {
  if (!s.active) return null;
  const seen = new Set<PosId>();
  for (const u of s.units) {
    if (u.carriedBy || isCastle(u.pos)) continue;
    if (seen.has(u.pos)) return "Units can't end on the same tile. Pick up, keep moving, or undo.";
    seen.add(u.pos);
  }
  const sup = supportedCells(s.cells);
  for (let i = 0; i < NCELLS; i++)
    if (s.cells[i] === BRIDGE && !sup[i]) return 'New bridges must connect back to a castle by the end of the move. Keep building or undo.';
  s.active = null;
  s.undo = [];
  checkSiegeWin(s);
  return null;
}

type Ctx = { u: Unit; a: ActiveUse };
function activeCtx(s: GameState): Ctx | string {
  if (!s.active) return 'Select a unit first.';
  const u = getUnit(s, s.active.unitId);
  if (!u) return 'That unit was destroyed.';
  return { u, a: s.active };
}

// ---------- validators (shared by apply and by UI queries) ----------

export function checkSelect(s: GameState, unitId: string): string | null {
  const u = getUnit(s, unitId);
  if (!u) return 'No such unit.';
  if (u.owner !== s.current) return "That's not your unit.";
  if (s.active?.unitId === unitId) return null;
  if (s.used.includes(unitId)) return 'That unit was already used this turn.';
  if (s.ap < USE_COST) return `Using a unit costs ${USE_COST} AP.`;
  return null;
}

/** Validates one movement step; returns 'build' if the step lays a new tile. */
export function checkStep(s: GameState, u: Unit, from: PosId, to: PosId): string | 'ok' | 'build' {
  if (!neighbors(s, from, u.owner).includes(to)) return 'Movement must be to an adjacent space.';
  if (isCastle(to)) return castleOwner(to) === u.owner ? 'ok' : "You can't enter the enemy castle.";
  const occ = unitAt(s, to);
  if (occ && occ.owner !== u.owner) return "You can't move through enemy units.";
  if (s.cells[to] === EMPTY) {
    if (u.type !== 'builder') return 'Only builders can move onto open ground.';
    if (s.players[u.owner].stockpile <= 0) return 'Your stockpile is empty. Mine more tiles to build.';
    return 'build';
  }
  return 'ok';
}

export function checkDestroyTile(s: GameState, c: Ctx, target: PosId, extra = false): string | null {
  const { u, a } = c;
  if (u.type !== 'builder') return 'Only builders can destroy.';
  if (u.carriedBy || isCastle(u.pos)) return 'The builder must be standing on the field.';
  if (extra) {
    if (a.ability !== 'destroyTile' || a.firstDestroyed === null) return 'Destroy a tile first.';
    if (a.extraDestroyUsed) return 'Only one extra tile can be destroyed per turn.';
    if (a.extraLocked) return 'The extra tile must be destroyed before the builder moves again.';
    if (s.ap < EXTRA_DESTROY_AP) return `An extra tile costs ${EXTRA_DESTROY_AP} AP.`;
    if (!CELL_NB[a.firstDestroyed].includes(target)) return 'The extra tile must be adjacent to the first destroyed tile.';
  } else {
    if (a.abilityUsed) return 'This unit already used its ability.';
    if (!CELL_NB[u.pos].includes(target)) return 'Target must be adjacent to the builder.';
  }
  if (isTower(s.cells[target])) return 'Use Destroy Tower on towers.';
  if (s.cells[target] !== BRIDGE) return 'There is no bridge tile there.';
  if (unitAt(s, target)) return "You can't destroy a tile with a unit on it.";
  return null;
}

export function checkDestroyTower(s: GameState, c: Ctx, target: PosId): string | null {
  const { u, a } = c;
  if (u.type !== 'builder') return 'Only builders can destroy towers.';
  if (a.abilityUsed) return 'This unit already used its ability.';
  if (u.carriedBy || isCastle(u.pos)) return 'The builder must be standing on the field.';
  if (!CELL_NB[u.pos].includes(target)) return 'The tower must be adjacent to the builder.';
  if (!isTower(s.cells[target])) return 'There is no tower there.';
  if (unitAt(s, target)) return "You can't destroy a tower with a unit on it.";
  if (s.ap < TOWER_DESTROY_AP) return `Destroying a tower costs ${TOWER_DESTROY_AP} more AP.`;
  return null;
}

export function checkBuildTower(s: GameState, c: Ctx): string | null {
  const { u, a } = c;
  if (u.type !== 'builder') return 'Only builders can build towers.';
  if (a.abilityUsed) return 'This unit already used its ability.';
  if (u.carriedBy || isCastle(u.pos)) return 'The builder must be standing on a bridge.';
  if (s.cells[u.pos] !== BRIDGE) return "There's already a tower here.";
  if (s.ap < TOWER_AP) return `A tower costs ${TOWER_AP} more AP.`;
  if (s.players[u.owner].stockpile < TOWER_TILES) return `A tower needs ${TOWER_TILES} tiles from your stockpile.`;
  return null;
}

export function checkDestroyCastle(s: GameState, c: Ctx): string | null {
  const { u, a } = c;
  if (u.type !== 'builder') return 'Only builders can destroy the castle.';
  if (a.abilityUsed) return 'The builder needs its ability unused to destroy the castle.';
  if (u.carriedBy || isCastle(u.pos)) return 'The builder must be on an enemy gate tile.';
  if (GATE_OWNER[u.pos] !== other(u.owner)) return 'The builder must be on an enemy gate tile.';
  if (c.a.movementLeft < 1) return 'The builder needs 1 movement left to enter the castle.';
  return null;
}

export function checkAttack(s: GameState, c: Ctx, target: PosId): string | null {
  const { u, a } = c;
  if (u.type !== 'seeker') return 'Only seekers can attack.';
  if (a.abilityUsed) return 'This unit already used its ability.';
  if (isCastle(target) || !neighbors(s, u.pos, u.owner).includes(target)) return 'Target must be adjacent.';
  const t = unitAt(s, target);
  if (!t || t.owner === u.owner) return 'There is no enemy there.';
  if (t.type === 'defender') return 'Defenders cannot be attacked by seekers.';
  return null;
}

/** Returns [mount, passenger] or an error. */
export function checkPickup(s: GameState, c: Ctx, partnerId: string): [Unit, Unit] | string {
  const { u, a } = c;
  if (a.abilityUsed) return 'This unit already used its ability.';
  if (u.type === 'defender') return 'Defenders cannot be carried.';
  if (u.carriedBy) return 'Already being carried.';
  const p = getUnit(s, partnerId);
  if (!p || p.owner !== u.owner || p.id === u.id) return 'Pick a friendly unit.';
  if (p.pos !== u.pos) return 'Move onto the same space first.';
  if (p.carriedBy) return 'That unit is already being carried.';
  if (u.type === 'mount') {
    if (u.carrying) return 'A mount carries one passenger at a time.';
    if (p.type === 'defender') return 'Defenders cannot be carried.';
    if (p.type === 'mount') return "Mounts can't carry mounts.";
    return [u, p];
  }
  if (p.type !== 'mount') return 'Only mounts can carry units.';
  if (p.carrying) return 'That mount already carries a passenger.';
  return [p, u];
}

/** Returns [mount, passenger] or an error. */
export function checkDropoff(s: GameState, c: Ctx, target: PosId): [Unit, Unit] | string {
  const { u, a } = c;
  if (a.abilityUsed) return 'This unit already used its ability.';
  let mount: Unit | undefined, pass: Unit | undefined;
  if (u.type === 'mount' && u.carrying) { mount = u; pass = getUnit(s, u.carrying); }
  else if (u.carriedBy) { pass = u; mount = getUnit(s, u.carriedBy); }
  if (!mount || !pass) return 'Nothing to drop off.';
  if (isCastle(target) || !neighbors(s, mount.pos, mount.owner).includes(target)) return 'Drop off onto a tile adjacent to the mount.';
  if (s.cells[target] === EMPTY) return 'Drop off onto a bridge tile.';
  if (unitAt(s, target)) return 'That tile is occupied.';
  return [mount, pass];
}

// ---------- apply ----------

const err = (error: string): Result => ({ ok: false, error });

export function applyAction(state: GameState, player: Player, action: Action): Result {
  if (state.winner !== null) return err('The game is over.');
  const s = structuredClone(state);
  if (action.type === 'resign') {
    s.winner = other(player);
    s.winReason = `${s.players[player].name} resigned.`;
    s.active = null;
    s.undo = [];
    return { ok: true, state: s };
  }
  if (player !== s.current) return err("It's not your turn.");
  const e = apply(s, action);
  return e ? err(e) : { ok: true, state: s };
}

export function applyActions(state: GameState, player: Player, actions: Action[]): Result {
  let s = state;
  for (const a of actions) {
    const r = applyAction(s, player, a);
    if (!r.ok) return r;
    s = r.state;
  }
  return { ok: true, state: s };
}

function apply(s: GameState, a: Action): string | null {
  const me = s.current;
  const ps = s.players[me];
  switch (a.type) {
    case 'select': {
      if (s.active?.unitId === a.unitId) return null;
      const pre = getUnit(s, a.unitId);
      if (!pre || pre.owner !== me) return checkSelect(s, a.unitId);
      if (s.used.includes(a.unitId)) return checkSelect(s, a.unitId);
      const ce = commit(s);
      if (ce) return ce;
      if (s.winner !== null) return null;
      const se = checkSelect(s, a.unitId);
      if (se) return se;
      const u = getUnit(s, a.unitId)!;
      snapshot(s);
      s.ap -= USE_COST;
      s.used.push(u.id);
      s.active = { unitId: u.id, movementLeft: MOVE[u.type], abilityUsed: false, ability: null, firstDestroyed: null, extraDestroyUsed: false, extraLocked: false };
      return null;
    }
    case 'move': {
      const c = activeCtx(s);
      if (typeof c === 'string') return c;
      const { u, a: act } = c;
      if (u.carriedBy) return "Carried units can't move. Drop off first.";
      if (!Array.isArray(a.path) || a.path.length === 0) return 'Empty path.';
      if (a.path.length > act.movementLeft) return 'Not enough movement left.';
      snapshot(s);
      let cur = u.pos, built = 0;
      for (const next of a.path) {
        const r = checkStep(s, u, cur, next);
        if (r !== 'ok' && r !== 'build') return r;
        if (r === 'build') { s.cells[next] = BRIDGE; ps.stockpile--; built++; }
        cur = next;
        u.pos = next;
        if (u.carrying) { const p = getUnit(s, u.carrying); if (p) p.pos = next; }
        act.movementLeft--;
      }
      if (act.firstDestroyed !== null) act.extraLocked = true;
      log(s, `${UNIT_NAME[u.type]} moved ${a.path.length}${built ? `, building ${built} tile${built > 1 ? 's' : ''}` : ''}.`);
      return null;
    }
    case 'destroyTile':
    case 'destroyExtra': {
      const c = activeCtx(s);
      if (typeof c === 'string') return c;
      const extra = a.type === 'destroyExtra';
      const e = checkDestroyTile(s, c, a.target, extra);
      if (e) return e;
      snapshot(s);
      s.cells[a.target] = EMPTY;
      if (extra) { s.ap -= EXTRA_DESTROY_AP; c.a.extraDestroyUsed = true; }
      else { c.a.abilityUsed = true; c.a.ability = 'destroyTile'; c.a.firstDestroyed = a.target; }
      log(s, `Builder destroyed a${extra ? 'n extra' : ''} bridge tile.` + describeCollapse(collapse(s)));
      return null;
    }
    case 'destroyTower': {
      const c = activeCtx(s);
      if (typeof c === 'string') return c;
      const e = checkDestroyTower(s, c, a.target);
      if (e) return e;
      snapshot(s);
      s.ap -= TOWER_DESTROY_AP;
      s.cells[a.target] = EMPTY;
      c.a.abilityUsed = true;
      c.a.ability = 'destroyTower';
      log(s, 'Builder destroyed a tower!' + describeCollapse(collapse(s)));
      return null;
    }
    case 'buildTower': {
      const c = activeCtx(s);
      if (typeof c === 'string') return c;
      const e = checkBuildTower(s, c);
      if (e) return e;
      snapshot(s);
      s.ap -= TOWER_AP;
      ps.stockpile -= TOWER_TILES;
      s.cells[c.u.pos] = towerValue(me);
      c.a.abilityUsed = true;
      c.a.ability = 'buildTower';
      log(s, 'Builder raised a tower.');
      return null;
    }
    case 'destroyCastle': {
      const c = activeCtx(s);
      if (typeof c === 'string') return c;
      const e = checkDestroyCastle(s, c);
      if (e) return e;
      c.u.pos = castleOf(other(me));
      c.a.movementLeft--;
      c.a.abilityUsed = true;
      c.a.ability = 'destroyCastle';
      s.active = null;
      s.undo = [];
      s.winner = me;
      s.winReason = `${ps.name}'s builder destroyed the enemy castle!`;
      log(s, 'Builder stormed the gate and destroyed the castle!');
      return null;
    }
    case 'attack': {
      const c = activeCtx(s);
      if (typeof c === 'string') return c;
      const e = checkAttack(s, c, a.target);
      if (e) return e;
      snapshot(s);
      const victims = killUnit(s, unitAt(s, a.target)!);
      c.u.pos = a.target;
      c.a.abilityUsed = true;
      c.a.ability = 'attack';
      log(s, `Seeker destroyed enemy ${victims.map((v) => UNIT_NAME[v.type]).join(' and ')}.`);
      return null;
    }
    case 'pickup': {
      const c = activeCtx(s);
      if (typeof c === 'string') return c;
      const r = checkPickup(s, c, a.partnerId);
      if (typeof r === 'string') return r;
      snapshot(s);
      const [mount, pass] = r;
      mount.carrying = pass.id;
      pass.carriedBy = mount.id;
      pass.pos = mount.pos;
      c.a.abilityUsed = true;
      c.a.ability = 'pickup';
      if (pass === c.u) c.a.movementLeft = 0;
      log(s, `Mount picked up ${UNIT_NAME[pass.type]}.`);
      return null;
    }
    case 'dropoff': {
      const c = activeCtx(s);
      if (typeof c === 'string') return c;
      const r = checkDropoff(s, c, a.target);
      if (typeof r === 'string') return r;
      snapshot(s);
      const [mount, pass] = r;
      mount.carrying = null;
      pass.carriedBy = null;
      pass.pos = a.target;
      c.a.abilityUsed = true;
      c.a.ability = 'dropoff';
      log(s, `Mount dropped off ${UNIT_NAME[pass.type]}.`);
      return null;
    }
    case 'undo': {
      if (!s.active || s.undo.length === 0) return 'Nothing to undo.';
      restore(s);
      return null;
    }
    case 'finish':
      return commit(s);
    case 'mine': {
      const ce = commit(s);
      if (ce || s.winner !== null) return ce;
      const n = a.count;
      if (!Number.isInteger(n) || n < 1) return 'Mine at least 1 tile.';
      if (n > s.ap) return 'Not enough AP.';
      if (underSiege(s, me)) return "You can't mine while under siege.";
      ps.stockpile += n;
      s.ap -= n;
      log(s, `Mined ${n} tile${n > 1 ? 's' : ''}.`);
      return null;
    }
    case 'recruit': {
      const ce = commit(s);
      if (ce || s.winner !== null) return ce;
      if (!UNIT_TYPES.includes(a.unitType)) return 'Unknown unit type.';
      if (underSiege(s, me)) return "You can't recruit while under siege.";
      if (s.ap < RECRUIT_COST) return `Recruiting costs ${RECRUIT_COST} AP.`;
      if (ps.recruitsUsed >= MAX_RECRUITS) return `You've used all ${MAX_RECRUITS} recruits.`;
      if (available(s, me, a.unitType) <= 0) return `All your ${UNIT_NAME[a.unitType]} pieces are already in play.`;
      ps.recruitsUsed++;
      s.ap -= RECRUIT_COST;
      addUnit(s, me, a.unitType);
      log(s, `Recruited a ${UNIT_NAME[a.unitType]}.`);
      return null;
    }
    case 'retrain': {
      const ce = commit(s);
      if (ce || s.winner !== null) return ce;
      const u = getUnit(s, a.unitId);
      if (!u || u.owner !== me) return 'Pick one of your units.';
      if (!UNIT_TYPES.includes(a.unitType)) return 'Unknown unit type.';
      if (u.pos !== castleOf(me) || u.carriedBy || u.carrying) return 'Only units inside your castle can be retrained.';
      if (u.type === a.unitType) return 'Pick a different unit type.';
      if (available(s, me, a.unitType) <= 0) return `All your ${UNIT_NAME[a.unitType]} pieces are already in play.`;
      if (s.ap < RETRAIN_COST) return `Retraining costs ${RETRAIN_COST} AP.`;
      log(s, `Retrained a ${UNIT_NAME[u.type]} as a ${UNIT_NAME[a.unitType]}.`);
      u.type = a.unitType;
      s.ap -= RETRAIN_COST;
      return null;
    }
    case 'endTurn': {
      const ce = commit(s);
      if (ce || s.winner !== null) return ce;
      checkSiegeWin(s);
      if (s.winner !== null) return null;
      s.current = other(me);
      s.ap = AP_PER_TURN;
      s.used = [];
      s.turn++;
      return null;
    }
    default:
      return 'Unknown action.';
  }
}
