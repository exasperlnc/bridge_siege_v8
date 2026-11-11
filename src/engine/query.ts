// Read-only helpers for the UI: reachable spaces, ability targets.
import { type GameState, type PosId, NCELLS, isCastle } from './types.ts';
import {
  checkAttack, checkBuildTower, checkDestroyCastle, checkDestroyTile, checkDestroyTower, checkDropoff, checkPickup,
  checkStep, getUnit, unitAt, neighbors as neighborsFn, CELL_NB,
} from './rules.ts';

export interface Reach {
  /** Destination -> path (excluding start) using the fewest new tiles, then fewest steps. */
  paths: Map<PosId, PosId[]>;
  /** Destination -> number of new tiles the path builds. */
  builds: Map<PosId, number>;
}

/**
 * Layered BFS over (steps, position) tracking the minimum tiles built.
 * Assumes `s.active` is the unit being moved.
 */
export function reachable(s: GameState): Reach {
  const paths = new Map<PosId, PosId[]>();
  const builds = new Map<PosId, number>();
  const a = s.active;
  const u = a && getUnit(s, a.unitId);
  if (!a || !u || u.carriedBy || a.movementLeft <= 0) return { paths, builds };

  const N = NCELLS + 2;
  const stock = s.players[u.owner].stockpile;
  const INF = 1e9;
  // best[k][p] = min tiles built reaching p in exactly k steps
  const best: Int32Array[] = [];
  const parent: Int32Array[] = [];
  for (let k = 0; k <= a.movementLeft; k++) { best.push(new Int32Array(N).fill(INF)); parent.push(new Int32Array(N).fill(-1)); }
  best[0][u.pos] = 0;
  for (let k = 0; k < a.movementLeft; k++) {
    for (let p = 0; p < N; p++) {
      const b = best[k][p];
      if (b === INF) continue;
      for (const n of neighborsFn(s, p, u.owner)) {
        const r = checkStep(s, u, p, n);
        if (r !== 'ok' && r !== 'build') continue;
        const nb = b + (r === 'build' ? 1 : 0);
        if (nb > stock) continue;
        if (nb < best[k + 1][n]) { best[k + 1][n] = nb; parent[k + 1][n] = p; }
      }
    }
  }
  for (let p = 0; p < N; p++) {
    if (p === u.pos) continue;
    let bk = -1, bb = INF;
    for (let k = 1; k <= a.movementLeft; k++) if (best[k][p] < bb) { bb = best[k][p]; bk = k; }
    if (bk < 0) continue;
    if (!isCastle(p)) {
      const occ = unitAt(s, p);
      if (occ && occ.id !== u.id) {
        // only stop on an ally if a pickup is possible there
        const ok = (u.type === 'mount' && !u.carrying && occ.type !== 'defender' && occ.type !== 'mount') ||
          (u.type !== 'mount' && u.type !== 'defender' && occ.type === 'mount' && !occ.carrying);
        if (!ok) continue;
      }
    }
    const path: PosId[] = [];
    let cur = p;
    for (let k = bk; k > 0; k--) { path.push(cur); cur = parent[k][cur]; }
    path.reverse();
    paths.set(p, path);
    builds.set(p, bb);
  }
  return { paths, builds };
}


export interface AbilityTargets {
  attack: PosId[];
  destroyTile: PosId[];
  destroyExtra: PosId[];
  destroyTower: PosId[];
  dropoff: PosId[];
  pickup: string[];
  buildTower: boolean;
  destroyCastle: boolean;
  /** Error messages explaining unavailable abilities (keyed by ability). */
  why: Record<string, string>;
}

export function abilityTargets(s: GameState): AbilityTargets {
  const t: AbilityTargets = { attack: [], destroyTile: [], destroyExtra: [], destroyTower: [], dropoff: [], pickup: [], buildTower: false, destroyCastle: false, why: {} };
  const a = s.active;
  const u = a && getUnit(s, a.unitId);
  if (!a || !u) return t;
  const c = { u, a };
  const around = isCastle(u.pos) ? [] : CELL_NB[u.pos];
  if (u.type === 'seeker') {
    for (const n of neighborsFn(s, u.pos, u.owner)) if (!isCastle(n) && !checkAttack(s, c, n)) t.attack.push(n);
  }
  if (u.type === 'builder') {
    for (const n of around) {
      if (!checkDestroyTile(s, c, n)) t.destroyTile.push(n);
      if (!checkDestroyTower(s, c, n)) t.destroyTower.push(n);
    }
    if (a.firstDestroyed !== null)
      for (const n of CELL_NB[a.firstDestroyed]) if (!checkDestroyTile(s, c, n, true)) t.destroyExtra.push(n);
    const bt = checkBuildTower(s, c);
    t.buildTower = !bt;
    if (bt) t.why.buildTower = bt;
    const dc = checkDestroyCastle(s, c);
    t.destroyCastle = !dc;
    if (dc) t.why.destroyCastle = dc;
  }
  for (const o of s.units) if (o.id !== u.id && typeof checkPickup(s, c, o.id) !== 'string') t.pickup.push(o.id);
  const mountPos = u.carrying ? u.pos : u.carriedBy ? getUnit(s, u.carriedBy)?.pos : undefined;
  if (mountPos !== undefined)
    for (const n of neighborsFn(s, mountPos, u.owner)) if (!isCastle(n) && typeof checkDropoff(s, c, n) !== 'string') t.dropoff.push(n);
  return t;
}
