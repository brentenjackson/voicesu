// Canvas rendering of the IPA quadrilateral + one osu-style cursor per engine.

import { VOWELS, ROWS, COLS, quadX } from './vowels.js';

const COLORS = {
  line: 'rgba(210, 220, 255, 0.28)',
  lineStrong: 'rgba(210, 220, 255, 0.55)',
  label: 'rgba(190, 200, 230, 0.55)',
  symbol: 'rgba(228, 234, 255, 0.82)',
  symbolHot: '#ffd76a',
  tagHalo: 'rgba(11, 13, 22, 0.85)', // page background, so tags read over grid lines
};

export class ChartRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.trails = new Map(); // cursor key -> recent positions
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

  pushTrail(key, backness, height) {
    let trail = this.trails.get(key);
    if (!trail) this.trails.set(key, (trail = []));
    trail.push({ b: backness, h: height, t: performance.now() });
    if (trail.length > this.maxTrail) trail.shift();
  }

  /** One cursor's trail, or every trail when no key is given. */
  clearTrail(key) {
    if (key === undefined) this.trails.clear();
    else this.trails.delete(key);
  }

  /**
   * @param cursors  [{ key, label, color, slot, backness, height, strength }],
   *                 painted in order, so put the one that matters most last
   * @param activeVowel  chart node to highlight, or null
   */
  draw(cursors, activeVowel) {
    const c = this.ctx;
    c.clearRect(0, 0, this.w, this.h);

    this.drawGridLines();
    this.punchSymbolHoles(); // knocks holes in the lines only
    this.drawGridLabels();
    this.drawSymbols(activeVowel);

    // Each cursor keeps its own trail; with several on screen they fade back
    // so the chart doesn't turn to soup.
    const fade = 1 / Math.sqrt(Math.max(1, cursors.length));
    for (const cur of cursors) this.drawTrail(this.trails.get(cur.key), cur.color, fade);
    for (const cur of cursors) this.drawCursor(cur.backness, cur.height, cur.strength, cur.color);
    // With more than one on screen, name them: identity is never color-only.
    if (cursors.length > 1) for (const cur of cursors) this.drawTag(cur);
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

  drawTrail(trail, color, fade = 1) {
    if (!trail) return;
    const c = this.ctx;
    const now = performance.now();
    for (let i = 0; i < trail.length; i++) {
      const t = trail[i];
      const age = (now - t.t) / 700;
      if (age > 1) continue;
      const p = this.toPx(t.b, t.h);
      const alpha = (1 - age) * 0.5 * fade * (i / trail.length);
      c.beginPath();
      c.arc(p.x, p.y, 3 + (1 - age) * 6, 0, Math.PI * 2);
      c.fillStyle = rgba(color, alpha);
      c.fill();
    }
  }

  cursorRadius(strength) { return 11 + strength * 7; }

  drawCursor(backness, height, strength, color) {
    const c = this.ctx;
    const p = this.toPx(backness, height);
    const r = this.cursorRadius(strength);

    const g = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3.2);
    g.addColorStop(0, rgba(color, 0.35));
    g.addColorStop(1, rgba(color, 0));
    c.fillStyle = g;
    c.beginPath(); c.arc(p.x, p.y, r * 3.2, 0, Math.PI * 2); c.fill();

    c.beginPath(); c.arc(p.x, p.y, r, 0, Math.PI * 2);
    c.strokeStyle = color;
    c.lineWidth = 3;
    c.stroke();

    c.beginPath(); c.arc(p.x, p.y, r * 0.34, 0, Math.PI * 2);
    c.fillStyle = '#fff';
    c.fill();
  }

  /**
   * Engine name beside its cursor. Each engine has a fixed corner (its slot),
   * so tags of cursors sitting on top of each other don't collide.
   */
  drawTag({ backness, height, strength, color, label, slot = 0 }) {
    const c = this.ctx;
    const p = this.toPx(backness, height);
    const ang = -Math.PI / 4 + (slot % 4) * (Math.PI / 2); // NE, SE, SW, NW
    const d = this.cursorRadius(strength) + 4;
    const x = p.x + Math.cos(ang) * d;
    const y = p.y + Math.sin(ang) * d;

    c.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    c.textAlign = Math.cos(ang) >= 0 ? 'left' : 'right';
    c.textBaseline = Math.sin(ang) < 0 ? 'bottom' : 'top';
    c.lineJoin = 'round';
    c.lineWidth = 3;
    c.strokeStyle = COLORS.tagHalo;
    c.strokeText(label, x, y);
    c.fillStyle = color;
    c.fillText(label, x, y);
  }
}

/** '#rrggbb' + alpha -> CSS rgba(). */
function rgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
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
