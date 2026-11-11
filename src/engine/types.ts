// Core data types and constants for Bridge Siege V8.
//
// Board coordinates: x = 0..W-1 (columns, the 12-wide side), y = 0..H-1 (rows).
// Player 0's castle sits below row H-1, player 1's castle sits above row 0.
// Positions are integers: 0..NCELLS-1 are board cells (y * W + x),
// NCELLS + p is player p's castle (one big space).

export const W = 12;
export const H = 15;
export const NCELLS = W * H;

export type Player = 0 | 1;
export type PosId = number;

export const castleOf = (p: Player): PosId => NCELLS + p;
export const isCastle = (pos: PosId) => pos >= NCELLS;
export const castleOwner = (pos: PosId): Player => (pos - NCELLS) as Player;
export const cellX = (pos: PosId) => pos % W;
export const cellY = (pos: PosId) => Math.floor(pos / W);
export const cellAt = (x: number, y: number): PosId => y * W + x;
export const other = (p: Player): Player => (1 - p) as Player;

export type UnitType = 'builder' | 'seeker' | 'defender' | 'mount';
export const UNIT_TYPES: UnitType[] = ['builder', 'seeker', 'defender', 'mount'];

export const MOVE: Record<UnitType, number> = { builder: 4, seeker: 4, defender: 3, mount: 6 };
/** Total pieces each player owns for the whole game. */
export const TOTAL: Record<UnitType, number> = { builder: 6, seeker: 3, defender: 3, mount: 3 };
/** Pieces placed in the castle at setup. */
export const START: Record<UnitType, number> = { builder: 2, seeker: 1, defender: 1, mount: 1 };

export const AP_PER_TURN = 8;
export const USE_COST = 2;
export const RECRUIT_COST = 6;
export const RETRAIN_COST = 4;
export const TOWER_AP = 6;
export const TOWER_TILES = 6;
export const TOWER_DESTROY_AP = 6;
export const EXTRA_DESTROY_AP = 2;
export const MAX_RECRUITS = 10;
export const START_STOCKPILE = 16;
export const SIEGE_ROWS = 4;
export const GATE_COLS = [4, 5, 6, 7];

/** Cell values. A tower is also a bridge tile (two tiles stacked). */
export const EMPTY = 0;
export const BRIDGE = 1;
export const TOWER0 = 2;
export const TOWER1 = 3;
export const towerValue = (p: Player) => (p === 0 ? TOWER0 : TOWER1);
export const isTower = (v: number) => v === TOWER0 || v === TOWER1;
export const towerOwner = (v: number): Player => (v === TOWER0 ? 0 : 1);

export interface Unit {
  id: string;
  owner: Player;
  type: UnitType;
  /** Board cell or castle. A carried unit's pos mirrors its mount's pos. */
  pos: PosId;
  carriedBy: string | null;
  carrying: string | null;
}

export interface PlayerState {
  name: string;
  stockpile: number;
  recruitsUsed: number;
  /** Pieces still available in the recruitment pool. */
  pool: Record<UnitType, number>;
  /** Pieces destroyed (out of play). */
  lost: Record<UnitType, number>;
}

export interface ActiveUse {
  unitId: string;
  movementLeft: number;
  abilityUsed: boolean;
  /** Which ability was used, for UI and for the extra-destroy follow-up. */
  ability: AbilityName | null;
  firstDestroyed: PosId | null;
  extraDestroyUsed: boolean;
}

export type AbilityName =
  | 'destroyTile'
  | 'destroyTower'
  | 'destroyCastle'
  | 'buildTower'
  | 'attack'
  | 'pickup'
  | 'dropoff';

export interface LogEntry {
  turn: number;
  player: Player;
  text: string;
}

export interface GameState {
  cells: number[];
  units: Unit[];
  players: [PlayerState, PlayerState];
  current: Player;
  ap: number;
  turn: number;
  /** Unit ids already used this turn. */
  used: string[];
  active: ActiveUse | null;
  /** Serialized snapshots for undoing within the current unit use. */
  undo: string[];
  winner: Player | null;
  winReason: string | null;
  nextId: number;
  log: LogEntry[];
}

export type Action =
  | { type: 'select'; unitId: string }
  | { type: 'move'; path: PosId[] }
  | { type: 'destroyTile'; target: PosId }
  | { type: 'destroyExtra'; target: PosId }
  | { type: 'destroyTower'; target: PosId }
  | { type: 'destroyCastle' }
  | { type: 'buildTower' }
  | { type: 'attack'; target: PosId }
  | { type: 'pickup'; partnerId: string }
  | { type: 'dropoff'; target: PosId }
  | { type: 'undo' }
  | { type: 'finish' }
  | { type: 'mine'; count: number }
  | { type: 'recruit'; unitType: UnitType }
  | { type: 'retrain'; unitId: string; unitType: UnitType }
  | { type: 'endTurn' }
  | { type: 'resign' };

export type Result = { ok: true; state: GameState } | { ok: false; error: string };
