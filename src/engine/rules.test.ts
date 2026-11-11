import { describe, expect, it } from 'vitest';
import {
  type Action, type GameState, type Player, type UnitType, BRIDGE, EMPTY, H, TOWER0, applyActions,
  castleOf, cellAt, getUnit, newGame, reachable, abilityTargets, underSiege,
} from './index.ts';

function ok(s: GameState, actions: Action[], p: Player = s.current): GameState {
  const r = applyActions(s, p, actions);
  if (!r.ok) throw new Error(r.error);
  return r.state;
}
function fails(s: GameState, actions: Action[], p: Player = s.current): string {
  const r = applyActions(s, p, actions);
  if (r.ok) throw new Error('expected failure');
  return r.error;
}
const unitOf = (s: GameState, p: Player, t: UnitType) => s.units.find((u) => u.owner === p && u.type === t)!;
/** Lay a straight column of bridge tiles from player 0's gate (x) up to row y. */
function column(s: GameState, x: number, fromY: number, toY: number) {
  for (let y = Math.min(fromY, toY); y <= Math.max(fromY, toY); y++) s.cells[cellAt(x, y)] = BRIDGE;
}
const G0 = cellAt(5, H - 1); // a player-0 gate cell

describe('setup', () => {
  it('starts with the right pieces, stockpile and AP', () => {
    const s = newGame();
    expect(s.units.filter((u) => u.owner === 0).map((u) => u.type).sort()).toEqual(['builder', 'builder', 'defender', 'mount', 'seeker']);
    expect(s.players[0].stockpile).toBe(16);
    expect(s.players[0].pool).toEqual({ builder: 4, seeker: 2, defender: 2, mount: 2 });
    expect(s.ap).toBe(8);
  });
});

describe('movement and building', () => {
  it('builder builds its way out of the gate, spending stockpile', () => {
    let s = newGame();
    const b = unitOf(s, 0, 'builder');
    s = ok(s, [{ type: 'select', unitId: b.id }, { type: 'move', path: [castleOf(0), G0].slice(1) }]);
    expect(s.cells[G0]).toBe(BRIDGE);
    expect(s.players[0].stockpile).toBe(15);
    expect(s.ap).toBe(6);
    expect(s.active!.movementLeft).toBe(3);
  });

  it('non-builders cannot walk onto open ground', () => {
    const s = newGame();
    const sk = unitOf(s, 0, 'seeker');
    expect(fails(s, [{ type: 'select', unitId: sk.id }, { type: 'move', path: [G0] }])).toMatch(/Only builders/);
  });

  it('builder cannot build with an empty stockpile', () => {
    const s = newGame();
    s.players[0].stockpile = 0;
    const b = unitOf(s, 0, 'builder');
    expect(fails(s, [{ type: 'select', unitId: b.id }, { type: 'move', path: [G0] }])).toMatch(/stockpile is empty/);
  });

  it('respects movement limits', () => {
    const s = newGame();
    column(s, 5, 8, H - 1);
    const d = unitOf(s, 0, 'defender');
    const path = [G0, cellAt(5, H - 2), cellAt(5, H - 3), cellAt(5, H - 4)];
    expect(fails(s, [{ type: 'select', unitId: d.id }, { type: 'move', path }])).toMatch(/movement/);
    ok(s, [{ type: 'select', unitId: d.id }, { type: 'move', path: path.slice(0, 3) }]);
  });

  it('cannot move through enemies but can pass allies', () => {
    const s = newGame();
    column(s, 5, 8, H - 1);
    const sk = unitOf(s, 0, 'seeker');
    const d = unitOf(s, 0, 'defender');
    d.pos = cellAt(5, H - 2);
    const path = [G0, cellAt(5, H - 2), cellAt(5, H - 3)];
    ok(s, [{ type: 'select', unitId: sk.id }, { type: 'move', path }]);
    unitOf(s, 1, 'defender').pos = cellAt(5, H - 2);
    d.pos = castleOf(0);
    expect(fails(s, [{ type: 'select', unitId: sk.id }, { type: 'move', path }])).toMatch(/enemy/);
  });

  it('cannot end on an allied unit', () => {
    const s = newGame();
    column(s, 5, 8, H - 1);
    unitOf(s, 0, 'defender').pos = cellAt(5, H - 2);
    const sk = unitOf(s, 0, 'seeker');
    expect(fails(s, [{ type: 'select', unitId: sk.id }, { type: 'move', path: [G0, cellAt(5, H - 2)] }, { type: 'finish' }])).toMatch(/same tile/);
  });

  it('a unit can only be used once per turn', () => {
    let s = newGame();
    const b = unitOf(s, 0, 'builder');
    const b2 = s.units.filter((u) => u.owner === 0 && u.type === 'builder')[1];
    s = ok(s, [{ type: 'select', unitId: b.id }, { type: 'move', path: [G0] }, { type: 'select', unitId: b2.id }]);
    expect(fails(s, [{ type: 'select', unitId: b.id }])).toMatch(/already used/);
  });

  it('reachable() finds builder paths that build', () => {
    let s = newGame();
    const b = unitOf(s, 0, 'builder');
    s = ok(s, [{ type: 'select', unitId: b.id }]);
    const r = reachable(s);
    expect(r.paths.get(cellAt(5, H - 4))).toHaveLength(4);
    expect(r.builds.get(cellAt(5, H - 4))).toBe(4);
  });
});

describe('undo', () => {
  it('undoes moves within a unit use and refunds selection', () => {
    let s = newGame();
    const b = unitOf(s, 0, 'builder');
    s = ok(s, [{ type: 'select', unitId: b.id }, { type: 'move', path: [G0] }, { type: 'undo' }]);
    expect(s.cells[G0]).toBe(EMPTY);
    expect(s.players[0].stockpile).toBe(16);
    expect(s.ap).toBe(6);
    s = ok(s, [{ type: 'undo' }]);
    expect(s.ap).toBe(8);
    expect(s.active).toBeNull();
  });

  it('cannot undo a finalized unit use', () => {
    let s = newGame();
    const b = unitOf(s, 0, 'builder');
    s = ok(s, [{ type: 'select', unitId: b.id }, { type: 'move', path: [G0] }, { type: 'mine', count: 1 }]);
    expect(fails(s, [{ type: 'undo' }])).toMatch(/Nothing/);
  });
});

describe('seeker', () => {
  it('attacks adjacent enemies (not defenders) and moves onto their tile', () => {
    const s = newGame();
    column(s, 5, 5, H - 1);
    const sk = unitOf(s, 0, 'seeker');
    sk.pos = cellAt(5, 8);
    const em = unitOf(s, 1, 'mount');
    const eb = unitOf(s, 1, 'builder');
    em.pos = eb.pos = cellAt(5, 7);
    em.carrying = eb.id; eb.carriedBy = em.id;
    const s2 = ok(s, [{ type: 'select', unitId: sk.id }, { type: 'attack', target: cellAt(5, 7) }]);
    expect(getUnit(s2, em.id)).toBeUndefined();
    expect(getUnit(s2, eb.id)).toBeUndefined();
    expect(getUnit(s2, sk.id)!.pos).toBe(cellAt(5, 7));
    expect(s2.players[1].lost.mount).toBe(1);
    expect(s2.players[1].lost.builder).toBe(1);

    em.pos = castleOf(1); eb.pos = castleOf(1); em.carrying = null; eb.carriedBy = null;
    unitOf(s, 1, 'defender').pos = cellAt(5, 7);
    expect(fails(s, [{ type: 'select', unitId: sk.id }, { type: 'attack', target: cellAt(5, 7) }])).toMatch(/Defenders/);
    expect(fails(s, [{ type: 'select', unitId: sk.id }, { type: 'attack', target: cellAt(4, 8) }])).toMatch(/no enemy/);
  });
});

describe('mount', () => {
  it('mount picks up and carries a unit; passenger drops itself off and moves', () => {
    let s = newGame();
    column(s, 5, 5, H - 1);
    const m = unitOf(s, 0, 'mount');
    const sk = unitOf(s, 0, 'seeker');
    s = ok(s, [
      { type: 'select', unitId: m.id },
      { type: 'pickup', partnerId: sk.id }, // both in the castle
      { type: 'move', path: [G0, cellAt(5, 13), cellAt(5, 12), cellAt(5, 11)] },
      { type: 'select', unitId: sk.id },
      { type: 'dropoff', target: cellAt(5, 10) },
      { type: 'move', path: [cellAt(5, 9), cellAt(5, 8)] },
    ]);
    expect(getUnit(s, sk.id)!.pos).toBe(cellAt(5, 8));
    // used drop-off as its ability, so it can't attack now
    unitOf(s, 1, 'builder').pos = cellAt(5, 7);
    expect(fails(s, [{ type: 'attack', target: cellAt(5, 7) }])).toMatch(/already used/);
  });

  it('a passenger that boards a mount is done for the turn', () => {
    let s = newGame();
    column(s, 5, 5, H - 1);
    const m = unitOf(s, 0, 'mount');
    m.pos = cellAt(5, 12);
    const b = unitOf(s, 0, 'builder');
    s = ok(s, [{ type: 'select', unitId: b.id }, { type: 'move', path: [G0, cellAt(5, 13), cellAt(5, 12)] }, { type: 'pickup', partnerId: m.id }]);
    expect(s.active!.movementLeft).toBe(0);
    s = ok(s, [{ type: 'select', unitId: m.id }, { type: 'move', path: [cellAt(5, 11)] }, { type: 'dropoff', target: cellAt(5, 10) }]);
    expect(fails(s, [{ type: 'select', unitId: b.id }])).toMatch(/already used/);
  });

  it('defenders cannot be carried', () => {
    const s = newGame();
    const m = unitOf(s, 0, 'mount');
    const d = unitOf(s, 0, 'defender');
    expect(fails(s, [{ type: 'select', unitId: m.id }, { type: 'pickup', partnerId: d.id }])).toMatch(/Defenders/);
  });
});

describe('builder destroy and structural integrity', () => {
  it('destroying a tile collapses the disconnected section and units on it', () => {
    const s = newGame();
    column(s, 5, 5, H - 1);
    const b = unitOf(s, 0, 'builder');
    b.pos = cellAt(5, 10);
    const enemy = unitOf(s, 1, 'seeker');
    enemy.pos = cellAt(5, 6);
    const s2 = ok(s, [{ type: 'select', unitId: b.id }, { type: 'destroyTile', target: cellAt(5, 9) }]);
    for (let y = 5; y <= 9; y++) expect(s2.cells[cellAt(5, y)]).toBe(EMPTY);
    expect(s2.cells[cellAt(5, 10)]).toBe(BRIDGE);
    expect(getUnit(s2, enemy.id)).toBeUndefined();
  });

  it('extra destroy costs 2 AP, must be adjacent, max one', () => {
    const s = newGame();
    column(s, 5, 5, H - 1);
    column(s, 4, 5, H - 1);
    const b = unitOf(s, 0, 'builder');
    b.pos = cellAt(6, 10);
    s.cells[b.pos] = BRIDGE;
    s.cells[cellAt(6, 11)] = BRIDGE;
    let s2 = ok(s, [{ type: 'select', unitId: b.id }, { type: 'destroyTile', target: cellAt(5, 10) }]);
    expect(fails(s2, [{ type: 'destroyExtra', target: cellAt(4, 5) }])).toMatch(/adjacent/);
    s2 = ok(s2, [{ type: 'destroyExtra', target: cellAt(5, 9) }]);
    expect(s2.ap).toBe(4);
    expect(fails(s2, [{ type: 'destroyExtra', target: cellAt(5, 11) }])).toMatch(/Only one/);
  });

  it('cannot destroy a tile with a unit on it', () => {
    const s = newGame();
    column(s, 5, 5, H - 1);
    const b = unitOf(s, 0, 'builder');
    b.pos = cellAt(5, 10);
    unitOf(s, 0, 'seeker').pos = cellAt(5, 9);
    expect(fails(s, [{ type: 'select', unitId: b.id }, { type: 'destroyTile', target: cellAt(5, 9) }])).toMatch(/unit on it/);
  });

  it('towers stand when cut off, but tiles around them fall', () => {
    const s = newGame();
    column(s, 5, 5, H - 1);
    s.cells[cellAt(5, 7)] = TOWER0;
    const b = unitOf(s, 0, 'builder');
    b.pos = cellAt(5, 10);
    const s2 = ok(s, [{ type: 'select', unitId: b.id }, { type: 'destroyTile', target: cellAt(5, 9) }]);
    expect(s2.cells[cellAt(5, 7)]).toBe(TOWER0);
    expect(s2.cells[cellAt(5, 6)]).toBe(EMPTY);
    expect(s2.cells[cellAt(5, 8)]).toBe(EMPTY);
  });

  it('building from an isolated tower must reconnect by the end of the move', () => {
    const s = newGame();
    column(s, 5, 9, H - 1);
    s.cells[cellAt(5, 6)] = TOWER0; // isolated: 5,7 and 5,8 are open ground
    const b = unitOf(s, 0, 'builder');
    // castle -> tower is one step
    expect(fails(s, [{ type: 'select', unitId: b.id }, { type: 'move', path: [cellAt(5, 6), cellAt(4, 6)] }, { type: 'finish' }])).toMatch(/connect/);
    ok(s, [{ type: 'select', unitId: b.id }, { type: 'move', path: [cellAt(5, 6), cellAt(5, 7), cellAt(5, 8)] }, { type: 'finish' }]);
  });

  it('build tower costs 6 AP and 6 tiles; destroy tower costs 6 AP', () => {
    let s = newGame();
    column(s, 5, 5, H - 1);
    const b = unitOf(s, 0, 'builder');
    s = ok(s, [{ type: 'select', unitId: b.id }, { type: 'move', path: [G0, cellAt(5, 13)] }, { type: 'buildTower' }]);
    expect(s.cells[cellAt(5, 13)]).toBe(TOWER0);
    expect(s.ap).toBe(0);
    expect(s.players[0].stockpile).toBe(10);
    s = ok(s, [{ type: 'endTurn' }]);
    getUnit(s, b.id)!.pos = castleOf(0);
    const eb = unitOf(s, 1, 'builder');
    eb.pos = cellAt(5, 12);
    s = ok(s, [{ type: 'select', unitId: eb.id }, { type: 'destroyTower', target: cellAt(5, 13) }]);
    expect(s.cells[cellAt(5, 13)]).toBe(EMPTY);
    expect(s.ap).toBe(0);
  });

  it('towers link to the castle for their owner only', () => {
    const s = newGame();
    column(s, 5, 5, H - 1);
    s.cells[cellAt(5, 6)] = TOWER0;
    const sk = unitOf(s, 0, 'seeker');
    ok(s, [{ type: 'select', unitId: sk.id }, { type: 'move', path: [cellAt(5, 6), cellAt(5, 5)] }]);
  });
});

describe('win conditions', () => {
  it('builder on enemy gate with movement and ability destroys the castle', () => {
    const s = newGame();
    column(s, 5, 0, H - 1);
    const b = unitOf(s, 0, 'builder');
    b.pos = cellAt(5, 2);
    const s2 = ok(s, [{ type: 'select', unitId: b.id }, { type: 'move', path: [cellAt(5, 1), cellAt(5, 0)] }, { type: 'destroyCastle' }]);
    expect(s2.winner).toBe(0);
    const s3 = ok(s, [{ type: 'select', unitId: b.id }, { type: 'move', path: [cellAt(5, 1), cellAt(5, 0), cellAt(5, 1), cellAt(5, 0)] }]);
    expect(fails(s3, [{ type: 'destroyCastle' }])).toMatch(/movement/);
  });

  it('siege blocks mining and recruiting, and wins when the defender is wiped out', () => {
    const s = newGame();
    column(s, 5, 0, H - 1);
    const sk = unitOf(s, 0, 'seeker');
    sk.pos = cellAt(5, 3);
    expect(underSiege(s, 1)).toBe(true);
    s.current = 1;
    expect(fails(s, [{ type: 'mine', count: 1 }])).toMatch(/siege/);
    expect(fails(s, [{ type: 'recruit', unitType: 'seeker' }])).toMatch(/siege/);
    s.units = s.units.filter((u) => u.owner === 0);
    const s2 = ok(s, [{ type: 'endTurn' }]);
    expect(s2.winner).toBe(0);
  });
});

describe('economy', () => {
  it('mines, recruits (max 10 total) and retrains', () => {
    let s = newGame();
    s = ok(s, [{ type: 'mine', count: 2 }, { type: 'recruit', unitType: 'seeker' }]);
    expect(s.players[0].stockpile).toBe(18);
    expect(s.players[0].pool.seeker).toBe(1);
    expect(s.ap).toBe(0);
    s.ap = 8;
    const d = unitOf(s, 0, 'defender');
    s = ok(s, [{ type: 'retrain', unitId: d.id, unitType: 'mount' }]);
    expect(getUnit(s, d.id)!.type).toBe('mount');
    expect(s.players[0].pool.defender).toBe(3);
    expect(s.players[0].pool.mount).toBe(1);
    s.players[0].recruitsUsed = 10;
    s.ap = 8;
    expect(fails(s, [{ type: 'recruit', unitType: 'builder' }])).toMatch(/all 10/);
  });

  it('cannot recruit beyond the piece supply', () => {
    const s = newGame();
    s.players[0].pool.seeker = 0;
    expect(fails(s, [{ type: 'recruit', unitType: 'seeker' }])).toMatch(/No Seeker/);
  });
});

describe('ability targets query', () => {
  it('lists seeker attack targets', () => {
    let s = newGame();
    column(s, 5, 5, H - 1);
    const sk = unitOf(s, 0, 'seeker');
    sk.pos = cellAt(5, 8);
    unitOf(s, 1, 'builder').pos = cellAt(5, 7);
    s = ok(s, [{ type: 'select', unitId: sk.id }]);
    expect(abilityTargets(s).attack).toEqual([cellAt(5, 7)]);
  });
});
