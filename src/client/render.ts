// Canvas 2D board renderer. Draws only on demand; all geometry derived from cell size.
import {
  type GameState, type Player, type PosId, type Unit, type UnitType, EMPTY, GATE_COLS, H, NCELLS, W,
  castleOf, cellAt, cellX, cellY, inSiegeZone, isCastle, isTower, towerOwner,
} from '../engine/index.ts';

export const COLORS: Record<Player, { main: string; dark: string; light: string; name: string }> = {
  0: { main: '#3b82f6', dark: '#1e3a8a', light: '#93c5fd', name: 'Azure' },
  1: { main: '#ef4444', dark: '#7f1d1d', light: '#fca5a5', name: 'Crimson' },
};

const STRIP = 1.5; // castle strip height in cells
const ROWS = H + STRIP * 2;

export type Mode = 'move' | 'destroyTile' | 'destroyExtra' | 'destroyTower' | 'dropoff';

export interface View {
  state: GameState;
  viewer: Player;
  focusId: string | null;
  canAct: boolean;
  mode: Mode;
  moves: Map<PosId, PosId[]>;
  builds: Map<PosId, number>;
  attack: PosId[];
  targets: PosId[]; // cells for the current targeting mode
  hover: PosId | null;
}

export type Hit = { kind: 'cell'; pos: PosId } | { kind: 'castle'; owner: Player; unitId: string | null };

interface Token { id: string; x: number; y: number; r: number }

export class BoardRenderer {
  private ctx: CanvasRenderingContext2D;
  cs = 32;
  private tokens: Token[] = [];
  private flip = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  /** Fit the board into the given CSS box. */
  fit(maxW: number, maxH: number) {
    const cs = Math.max(16, Math.floor(Math.min(maxW / W, maxH / ROWS)));
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.cs = cs;
    const w = cs * W, h = Math.round(cs * ROWS);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ----- coordinate mapping -----
  private sx(x: number) { return (this.flip ? W - 1 - x : x) * this.cs; }
  private sy(y: number) { return ((this.flip ? H - 1 - y : y) + STRIP) * this.cs; }
  private cellRect(pos: PosId): [number, number] { return [this.sx(cellX(pos)), this.sy(cellY(pos))]; }
  /** Top strip shows the player whose castle is above row 0 in screen space. */
  private stripOwner(top: boolean): Player { return (top !== this.flip ? 1 : 0) as Player; }
  private stripY(owner: Player) { return this.stripOwner(true) === owner ? 0 : (STRIP + H) * this.cs; }

  hit(px: number, py: number): Hit | null {
    const cs = this.cs;
    for (const t of this.tokens) if ((px - t.x) ** 2 + (py - t.y) ** 2 <= (t.r + 3) ** 2) {
      const owner = py < STRIP * cs ? this.stripOwner(true) : this.stripOwner(false);
      return { kind: 'castle', owner, unitId: t.id };
    }
    if (py < STRIP * cs) return { kind: 'castle', owner: this.stripOwner(true), unitId: null };
    if (py >= (STRIP + H) * cs) return { kind: 'castle', owner: this.stripOwner(false), unitId: null };
    let x = Math.floor(px / cs), y = Math.floor(py / cs - STRIP);
    if (x < 0 || x >= W || y < 0 || y >= H) return null;
    if (this.flip) { x = W - 1 - x; y = H - 1 - y; }
    return { kind: 'cell', pos: cellAt(x, y) };
  }

  draw(v: View) {
    const { ctx, cs } = this;
    const s = v.state;
    this.flip = v.viewer === 1;
    this.tokens = [];
    const bw = W * cs, bh = H * cs;
    ctx.clearRect(0, 0, bw, ROWS * cs);

    // chasm
    const g = ctx.createLinearGradient(0, STRIP * cs, 0, STRIP * cs + bh);
    g.addColorStop(0, '#0a1a26'); g.addColorStop(0.5, '#0f2534'); g.addColorStop(1, '#0a1a26');
    ctx.fillStyle = g;
    ctx.fillRect(0, STRIP * cs, bw, bh);

    // siege zones
    for (const p of [0, 1] as Player[]) {
      ctx.fillStyle = COLORS[p].main + '14';
      for (let y = 0; y < H; y++) if (inSiegeZone(p, y)) ctx.fillRect(0, this.sy(y), bw, cs);
      const b = p === 0 ? H - 4 : 4; // board row where the siege zone begins
      const ly = this.flip ? H - b : b;
      ctx.strokeStyle = COLORS[p].main + '55';
      ctx.setLineDash([cs * 0.2, cs * 0.15]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, (ly + STRIP) * cs + 0.5);
      ctx.lineTo(bw, (ly + STRIP) * cs + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // grid
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 1; x < W; x++) { ctx.moveTo(x * cs + 0.5, STRIP * cs); ctx.lineTo(x * cs + 0.5, STRIP * cs + bh); }
    for (let y = 1; y < H; y++) { ctx.moveTo(0, (y + STRIP) * cs + 0.5); ctx.lineTo(bw, (y + STRIP) * cs + 0.5); }
    ctx.stroke();

    // gate markers on empty gate cells
    for (const p of [0, 1] as Player[]) {
      const y = p === 0 ? H - 1 : 0;
      for (const x of GATE_COLS) {
        const pos = cellAt(x, y);
        if (s.cells[pos] !== EMPTY) continue;
        const [rx, ry] = this.cellRect(pos);
        ctx.strokeStyle = COLORS[p].main + '88';
        ctx.setLineDash([3, 3]);
        ctx.strokeRect(rx + 3.5, ry + 3.5, cs - 7, cs - 7);
        ctx.setLineDash([]);
      }
    }

    // bridges and towers
    for (let i = 0; i < NCELLS; i++) if (s.cells[i] !== EMPTY) this.drawTile(s, i);

    this.drawCastle(s, 0, v);
    this.drawCastle(s, 1, v);

    // highlights
    if (v.focusId) this.drawHighlights(v);

    // units on board
    for (const u of s.units) if (!isCastle(u.pos) && !u.carriedBy) {
      const [rx, ry] = this.cellRect(u.pos);
      this.drawUnit(s, u, rx + cs / 2, ry + cs / 2, cs * 0.36, v);
    }
  }

  private drawTile(s: GameState, i: PosId) {
    const { ctx, cs } = this;
    const [x, y] = this.cellRect(i);
    const v = s.cells[i];
    ctx.fillStyle = '#9a6a3a';
    ctx.fillRect(x, y, cs, cs);
    // planks
    ctx.strokeStyle = 'rgba(60,35,15,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const vertical = false;
    for (let k = 1; k < 4; k++) {
      const o = Math.round((k * cs) / 4) + 0.5;
      if (vertical) { ctx.moveTo(x + o, y); ctx.lineTo(x + o, y + cs); } else { ctx.moveTo(x, y + o); ctx.lineTo(x + cs, y + o); }
    }
    ctx.stroke();
    // dark edge where the neighbor is open ground
    ctx.fillStyle = 'rgba(30,15,5,0.7)';
    const e = Math.max(2, cs * 0.07);
    const sx = cellX(i), sy = cellY(i);
    const open = (nx: number, ny: number) => nx < 0 || ny < 0 || nx >= W || ny >= H || s.cells[cellAt(nx, ny)] === EMPTY;
    // screen-space directions
    const dU = this.flip ? [0, 1] : [0, -1], dD = this.flip ? [0, -1] : [0, 1];
    const dL = this.flip ? [1, 0] : [-1, 0], dR = this.flip ? [-1, 0] : [1, 0];
    if (open(sx + dU[0], sy + dU[1])) ctx.fillRect(x, y, cs, e);
    if (open(sx + dD[0], sy + dD[1])) ctx.fillRect(x, y + cs - e, cs, e);
    if (open(sx + dL[0], sy + dL[1])) ctx.fillRect(x, y, e, cs);
    if (open(sx + dR[0], sy + dR[1])) ctx.fillRect(x + cs - e, y, e, cs);

    if (isTower(v)) {
      const o = towerOwner(v);
      const m = cs * 0.1;
      ctx.fillStyle = '#6b7280';
      ctx.fillRect(x + m, y + m, cs - 2 * m, cs - 2 * m);
      ctx.fillStyle = '#9ca3af';
      const n = 4, bwid = (cs - 2 * m) / (n * 2 - 1);
      for (let k = 0; k < n; k++) ctx.fillRect(x + m + k * 2 * bwid, y + m, bwid, cs * 0.12);
      ctx.fillStyle = COLORS[o].main;
      ctx.fillRect(x + cs * 0.3, y + cs * 0.38, cs * 0.4, cs * 0.4);
      ctx.strokeStyle = '#111827';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x + m, y + m, cs - 2 * m, cs - 2 * m);
    }
  }

  private drawCastle(s: GameState, owner: Player, v: View) {
    const { ctx, cs } = this;
    const y0 = this.stripY(owner);
    const h = STRIP * cs, w = W * cs;
    const top = y0 === 0;
    ctx.fillStyle = '#374151';
    ctx.fillRect(0, y0, w, h);
    ctx.fillStyle = COLORS[owner].dark + 'cc';
    ctx.fillRect(0, y0, w, h);
    // battlements on the board-facing edge
    const by = top ? y0 + h - cs * 0.22 : y0;
    ctx.fillStyle = '#4b5563';
    for (let x = 0; x < W * 2; x++) if (x % 2 === 0) ctx.fillRect(x * cs / 2, by, cs / 2, cs * 0.22);
    // gate opening
    const gx0 = this.sx(this.flip ? GATE_COLS[GATE_COLS.length - 1] : GATE_COLS[0]);
    ctx.fillStyle = '#111827';
    ctx.fillRect(gx0, by, cs * GATE_COLS.length, cs * 0.22);
    // reachable castle highlight
    if (v.canAct && v.moves.has(castleOf(owner))) {
      ctx.fillStyle = 'rgba(74,222,128,0.22)';
      ctx.fillRect(0, y0, w, h);
      ctx.strokeStyle = 'rgba(74,222,128,0.9)';
      ctx.lineWidth = 2;
      ctx.strokeRect(1, y0 + 1, w - 2, h - 2);
    }
    // label
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = `600 ${Math.max(10, cs * 0.32)}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    const label = owner === v.viewer ? 'Your castle' : `${s.players[owner].name}'s castle`;
    const ly = top ? y0 + cs * 0.38 : y0 + h - cs * 0.38;
    ctx.textAlign = 'left';
    ctx.fillText(label, cs * 0.2, ly);
    // units inside
    const inside = s.units.filter((u) => u.pos === castleOf(owner) && !u.carriedBy);
    if (!inside.length) return;
    const rows = inside.length > 9 ? 2 : 1;
    const per = Math.ceil(inside.length / rows);
    const areaY = top ? y0 : y0 + cs * 0.22;
    const areaH = h - cs * 0.22;
    const r = Math.min(cs * 0.36, areaH / rows / 2 - 2, (w * 0.62) / per / 2 - 2);
    inside.forEach((u, k) => {
      const row = Math.floor(k / per), col = k % per;
      const n = Math.min(per, inside.length - row * per);
      const cx = w * 0.36 + ((col + 0.5) * (w * 0.62)) / n;
      const cy = areaY + (areaH / rows) * (row + 0.5);
      this.drawUnit(s, u, cx, cy, r, v);
      this.tokens.push({ id: u.id, x: cx, y: cy, r });
    });
  }

  private drawHighlights(v: View) {
    const { ctx, cs } = this;
    if (!v.canAct) return;
    if (v.mode === 'move') {
      for (const pos of v.moves.keys()) {
        if (isCastle(pos)) continue;
        const [x, y] = this.cellRect(pos);
        const b = v.builds.get(pos) ?? 0;
        ctx.fillStyle = b ? 'rgba(250,204,21,0.20)' : 'rgba(74,222,128,0.25)';
        ctx.fillRect(x + 1, y + 1, cs - 2, cs - 2);
        ctx.strokeStyle = b ? 'rgba(250,204,21,0.8)' : 'rgba(74,222,128,0.75)';
        ctx.lineWidth = 1.5;
        if (b) ctx.setLineDash([4, 3]);
        ctx.strokeRect(x + 2, y + 2, cs - 4, cs - 4);
        ctx.setLineDash([]);
      }
      for (const pos of v.attack) this.ring(pos, '#f43f5e', true);
      if (v.hover !== null && v.moves.has(v.hover)) {
        const path = v.moves.get(v.hover)!;
        ctx.fillStyle = '#fef08a';
        for (const p of path) {
          if (isCastle(p)) continue;
          const [x, y] = this.cellRect(p);
          ctx.beginPath();
          ctx.arc(x + cs / 2, y + cs / 2, cs * 0.09, 0, Math.PI * 2);
          ctx.fill();
        }
        const b = v.builds.get(v.hover) ?? 0;
        if (b && !isCastle(v.hover)) {
          const [x, y] = this.cellRect(v.hover);
          ctx.fillStyle = '#fde047';
          ctx.font = `700 ${cs * 0.3}px system-ui, sans-serif`;
          ctx.textAlign = 'right';
          ctx.textBaseline = 'top';
          ctx.fillText(`-${b}`, x + cs - 3, y + 2);
        }
      }
    } else {
      const col = v.mode === 'dropoff' ? '#22d3ee' : '#fb923c';
      for (const pos of v.targets) {
        const [x, y] = this.cellRect(pos);
        ctx.fillStyle = col + '40';
        ctx.fillRect(x + 1, y + 1, cs - 2, cs - 2);
        ctx.strokeStyle = col;
        ctx.lineWidth = 2;
        if (v.mode !== 'dropoff') {
          ctx.beginPath();
          ctx.moveTo(x + cs * 0.28, y + cs * 0.28); ctx.lineTo(x + cs * 0.72, y + cs * 0.72);
          ctx.moveTo(x + cs * 0.72, y + cs * 0.28); ctx.lineTo(x + cs * 0.28, y + cs * 0.72);
          ctx.stroke();
        }
        ctx.strokeRect(x + 2, y + 2, cs - 4, cs - 4);
      }
    }
  }

  private ring(pos: PosId, color: string, thick = false) {
    const { ctx, cs } = this;
    const [x, y] = this.cellRect(pos);
    ctx.strokeStyle = color;
    ctx.lineWidth = thick ? 3 : 2;
    ctx.beginPath();
    ctx.arc(x + cs / 2, y + cs / 2, cs * 0.45, 0, Math.PI * 2);
    ctx.stroke();
  }

  private drawUnit(s: GameState, u: Unit, cx: number, cy: number, r: number, v: View) {
    const { ctx } = this;
    const used = s.current === u.owner && s.used.includes(u.id) && s.active?.unitId !== u.id;
    ctx.globalAlpha = used ? 0.5 : 1;
    if (s.active?.unitId === u.id) {
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.beginPath(); ctx.arc(cx, cy, r * 1.35, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = COLORS[u.owner].main;
    ctx.strokeStyle = COLORS[u.owner].dark;
    ctx.lineWidth = Math.max(1.5, r * 0.14);
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    drawIcon(ctx, u.type, cx, cy, r * 0.62);
    if (v.focusId === u.id) {
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(cx, cy, r + 4, 0, Math.PI * 2); ctx.stroke();
    }
    if (u.carrying) {
      const p = s.units.find((o) => o.id === u.carrying);
      if (p) {
        const pr = r * 0.55, px = cx + r * 0.75, py = cy - r * 0.75;
        ctx.fillStyle = COLORS[p.owner].light;
        ctx.strokeStyle = COLORS[p.owner].dark;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        drawIcon(ctx, p.type, px, py, pr * 0.6, COLORS[p.owner].dark);
        if (v.focusId === p.id) {
          ctx.strokeStyle = '#facc15'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(px, py, pr + 3, 0, Math.PI * 2); ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Screen position of a carried unit's badge, for hit testing passengers. */
  passengerHit(s: GameState, px: number, py: number): string | null {
    const cs = this.cs;
    for (const u of s.units) if (u.carrying && !isCastle(u.pos)) {
      const [x, y] = this.cellRect(u.pos);
      const r = cs * 0.36, bx = x + cs / 2 + r * 0.75, by = y + cs / 2 - r * 0.75;
      if ((px - bx) ** 2 + (py - by) ** 2 <= (r * 0.55 + 2) ** 2) return u.carrying;
    }
    return null;
  }
}

export function drawIcon(ctx: CanvasRenderingContext2D, t: UnitType, cx: number, cy: number, s: number, color = '#fff') {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1.5, s * 0.22);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  switch (t) {
    case 'builder': // hammer
      ctx.rotate(-Math.PI / 4);
      ctx.fillRect(-s * 0.11, -s * 0.35, s * 0.22, s * 1.15);
      ctx.fillRect(-s * 0.6, -s * 0.75, s * 1.2, s * 0.42);
      break;
    case 'seeker': // sword
      ctx.moveTo(-s * 0.6, s * 0.6); ctx.lineTo(s * 0.7, -s * 0.7); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-s * 0.55, s * 0.05); ctx.lineTo(-s * 0.05, s * 0.55); ctx.stroke();
      break;
    case 'defender': // shield
      ctx.moveTo(0, -s * 0.8);
      ctx.lineTo(s * 0.7, -s * 0.5);
      ctx.quadraticCurveTo(s * 0.65, s * 0.45, 0, s * 0.85);
      ctx.quadraticCurveTo(-s * 0.65, s * 0.45, -s * 0.7, -s * 0.5);
      ctx.closePath();
      ctx.stroke();
      break;
    case 'mount': // horseshoe
      ctx.arc(0, -s * 0.05, s * 0.6, Math.PI * 0.85, Math.PI * 2.15);
      ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-s * 0.55, s * 0.2); ctx.lineTo(-s * 0.45, s * 0.75); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(s * 0.55, s * 0.2); ctx.lineTo(s * 0.45, s * 0.75); ctx.stroke();
      break;
  }
  ctx.restore();
}
