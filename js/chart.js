// Canvas rendering of the IPA quadrilateral + the osu-style cursor.

import { VOWELS, ROWS, COLS, quadX } from './vowels.js';

const COLORS = {
  line: 'rgba(210, 220, 255, 0.28)',
  lineStrong: 'rgba(210, 220, 255, 0.55)',
  label: 'rgba(190, 200, 230, 0.55)',
  symbol: 'rgba(228, 234, 255, 0.82)',
  symbolHot: '#ffd76a',
  cursor: '#ff5fa2',
  cursorGlow: 'rgba(255, 95, 162, 0.35)',
  trail: '90, 220, 255',
};

export class ChartRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.trail = [];
    this.maxTrail = 45;
    this.resize();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = r.width;
    this.h = r.height;

    // Keep the quad a sensible aspect ratio and centered, with room for labels.
    const padX = 104, padTop = 62, padBottom = 40;
    const availW = this.w - padX * 2;
    const availH = this.h - padTop - padBottom;
    const quadW = Math.min(availW, availH * 1.25);
    const quadH = Math.min(availH, quadW / 1.25);
    this.qx = (this.w - quadW) / 2;
    this.qy = padTop + (availH - quadH) / 2;
    this.qw = quadW;
    this.qh = quadH;
  }

  /** Normalized (backness, height) -> canvas pixels. */
  toPx(backness, height) {
    return {
      x: this.qx + quadX(backness, height) * this.qw,
      y: this.qy + height * this.qh,
    };
  }

  pushTrail(backness, height) {
    this.trail.push({ b: backness, h: height, t: performance.now() });
    if (this.trail.length > this.maxTrail) this.trail.shift();
  }

  clearTrail() { this.trail.length = 0; }

  draw(cursor, activeVowel) {
    const c = this.ctx;
    c.clearRect(0, 0, this.w, this.h);

    this.drawGridLines();
    this.punchSymbolHoles(); // knocks holes in the lines only
    this.drawGridLabels();
    this.drawSymbols(activeVowel);
    this.drawTrail();
    if (cursor) this.drawCursor(cursor.backness, cursor.height, cursor.strength);
  }

  drawGridLines() {
    const c = this.ctx;

    // Outline of the quadrilateral.
    const tl = this.toPx(0, 0), tr = this.toPx(1, 0);
    const bl = this.toPx(0, 1), br = this.toPx(1, 1);
    c.lineWidth = 1.5;
    c.strokeStyle = COLORS.lineStrong;
    c.beginPath();
    c.moveTo(tl.x, tl.y); c.lineTo(tr.x, tr.y);
    c.lineTo(br.x, br.y); c.lineTo(bl.x, bl.y);
    c.closePath();
    c.stroke();

    // Height rows.
    c.lineWidth = 1;
    c.strokeStyle = COLORS.line;
    for (const row of ROWS) {
      if (row.y === 0 || row.y === 1) continue; // already drawn as the outline
      const a = this.toPx(0, row.y), b = this.toPx(1, row.y);
      c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
    }
    // Backness columns follow the slant; front and back are the outline.
    for (const col of COLS) {
      if (col.x === 0 || col.x === 1) continue;
      const a = this.toPx(col.x, 0), b = this.toPx(col.x, 1);
      c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
    }
  }

  /** Drawn after the hole punch so the knockout can't eat the text. */
  drawGridLabels() {
    const c = this.ctx;
    c.font = '11px ui-sans-serif, system-ui, sans-serif';
    c.fillStyle = COLORS.label;

    c.textAlign = 'right';
    c.textBaseline = 'middle';
    for (const row of ROWS) {
      const a = this.toPx(0, row.y);
      // Clear the paired glyph, which hangs 15px left of the edge.
      c.fillText(row.label, a.x - 36, a.y);
    }

    c.textAlign = 'center';
    c.textBaseline = 'bottom';
    for (const col of COLS) {
      const a = this.toPx(col.x, 0);
      c.fillText(col.label, a.x, a.y - 30);
    }
  }

  /** Positions of every glyph, so holes and text stay in sync. */
  symbolSlots() {
    const slots = [];
    for (const v of VOWELS) {
      const p = this.toPx(v.x, v.y);
      if (v.s.length === 1) {
        slots.push({ v, sym: v.s[0], x: p.x, y: p.y });
      } else {
        slots.push({ v, sym: v.s[0], x: p.x - 15, y: p.y });
        slots.push({ v, sym: v.s[1], x: p.x + 15, y: p.y });
      }
    }
    return slots;
  }

  /**
   * Symbols sit *on* the grid lines, as they do on the printed IPA chart, so
   * knock the lines out from behind each glyph rather than striking through it.
   */
  punchSymbolHoles() {
    const c = this.ctx;
    c.save();
    c.globalCompositeOperation = 'destination-out';
    c.fillStyle = '#000';
    for (const slot of this.symbolSlots()) {
      c.beginPath();
      c.ellipse(slot.x, slot.y, 11, 12, 0, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }

  drawSymbols(activeVowel) {
    const c = this.ctx;
    c.textAlign = 'center';
    c.textBaseline = 'middle';

    // Halo behind whichever vowel the cursor is nearest.
    if (activeVowel) {
      const p = this.toPx(activeVowel.x, activeVowel.y);
      c.beginPath();
      c.arc(p.x, p.y, activeVowel.s.length > 1 ? 30 : 18, 0, Math.PI * 2);
      c.fillStyle = 'rgba(255, 215, 106, 0.13)';
      c.fill();
    }

    for (const slot of this.symbolSlots()) {
      const hot = activeVowel === slot.v;
      c.font = `${hot ? '600 ' : ''}19px "Charis SIL", "Doulos SIL", "Gentium Plus", "DejaVu Sans", serif`;
      c.fillStyle = hot ? COLORS.symbolHot : COLORS.symbol;
      c.fillText(slot.sym, slot.x, slot.y);
    }
  }

  drawTrail() {
    const c = this.ctx;
    const now = performance.now();
    for (let i = 0; i < this.trail.length; i++) {
      const t = this.trail[i];
      const age = (now - t.t) / 700;
      if (age > 1) continue;
      const p = this.toPx(t.b, t.h);
      const alpha = (1 - age) * 0.5 * (i / this.trail.length);
      c.beginPath();
      c.arc(p.x, p.y, 3 + (1 - age) * 6, 0, Math.PI * 2);
      c.fillStyle = `rgba(${COLORS.trail}, ${alpha})`;
      c.fill();
    }
  }

  drawCursor(backness, height, strength) {
    const c = this.ctx;
    const p = this.toPx(backness, height);
    const r = 11 + strength * 7;

    const g = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3.2);
    g.addColorStop(0, COLORS.cursorGlow);
    g.addColorStop(1, 'rgba(255, 95, 162, 0)');
    c.fillStyle = g;
    c.beginPath(); c.arc(p.x, p.y, r * 3.2, 0, Math.PI * 2); c.fill();

    c.beginPath(); c.arc(p.x, p.y, r, 0, Math.PI * 2);
    c.strokeStyle = COLORS.cursor;
    c.lineWidth = 3;
    c.stroke();

    c.beginPath(); c.arc(p.x, p.y, r * 0.34, 0, Math.PI * 2);
    c.fillStyle = '#fff';
    c.fill();
  }
}

/** Small spectrum + LPC-envelope scope. Mostly a debugging aid, but a fun one. */
export class ScopeRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.resize();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = r.width;
    this.h = r.height;
  }

  draw(state, nyquist) {
    const c = this.ctx;
    c.clearRect(0, 0, this.w, this.h);
    c.fillStyle = 'rgba(255,255,255,0.02)';
    c.fillRect(0, 0, this.w, this.h);

    const maxHz = 4500;
    const xOf = (hz) => (hz / maxHz) * this.w;
    const yOf = (db, lo, hi) => this.h - ((db - lo) / (hi - lo)) * this.h;

    // Raw FFT magnitude.
    if (state.spectrum) {
      const bins = state.spectrum.length;
      const binHz = nyquist / bins;
      c.beginPath();
      for (let i = 0; i < bins; i++) {
        const hz = i * binHz;
        if (hz > maxHz) break;
        const y = yOf(state.spectrum[i], -110, -10);
        i === 0 ? c.moveTo(xOf(hz), y) : c.lineTo(xOf(hz), y);
      }
      c.strokeStyle = 'rgba(150, 170, 220, 0.45)';
      c.lineWidth = 1;
      c.stroke();
    }

    // LPC envelope, normalized to its own range so it overlays nicely.
    if (state.envelope && state.voiced) {
      const env = state.envelope;
      let lo = Infinity, hi = -Infinity;
      for (const v of env) { if (v < lo) lo = v; if (v > hi) hi = v; }
      const span = Math.max(1, hi - lo);
      c.beginPath();
      for (let i = 0; i < env.length; i++) {
        const hz = (i / (env.length - 1)) * nyquist;
        if (hz > maxHz) break;
        const y = this.h - ((env[i] - lo) / span) * this.h * 0.92 - 4;
        i === 0 ? c.moveTo(xOf(hz), y) : c.lineTo(xOf(hz), y);
      }
      c.strokeStyle = '#5adcff';
      c.lineWidth = 2;
      c.stroke();
    }

    // Formant markers.
    if (state.voiced) {
      const marks = [
        [state.f1, '#ff5fa2', 'F1'],
        [state.f2, '#ffd76a', 'F2'],
        [state.f3, 'rgba(255,255,255,0.3)', 'F3'],
      ];
      c.font = '10px ui-monospace, monospace';
      c.textAlign = 'center';
      for (const [hz, color, label] of marks) {
        if (!hz || hz > maxHz) continue;
        const x = xOf(hz);
        c.strokeStyle = color;
        c.lineWidth = 1.5;
        c.setLineDash([3, 3]);
        c.beginPath(); c.moveTo(x, 0); c.lineTo(x, this.h); c.stroke();
        c.setLineDash([]);
        c.fillStyle = color;
        c.fillText(label, x, 11);
      }
    }
  }
}
