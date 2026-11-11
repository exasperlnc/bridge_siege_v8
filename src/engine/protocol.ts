import type { Action, GameState, Player } from './types.ts';

export type ClientMsg =
  | { t: 'create'; name: string }
  | { t: 'join'; room: string; name: string; token?: string }
  | { t: 'act'; actions: Action[] }
  | { t: 'rematch' }
  | { t: 'ping' };

export interface SeatInfo { name: string; connected: boolean }

export type ServerMsg =
  | { t: 'joined'; room: string; seat: Player; token: string }
  | { t: 'room'; room: string; seats: (SeatInfo | null)[]; state: GameState | null; rev: number }
  | { t: 'error'; msg: string }
  | { t: 'pong' };
