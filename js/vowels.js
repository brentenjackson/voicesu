// IPA vowel chart geometry + the formant -> chart-position mapping.

import { hzToBark } from './dsp.js';

/**
 * The IPA quadrilateral in normalized space.
 * x: 0 = front, 1 = back.  y: 0 = close, 1 = open.
 * The front edge slants right as it descends -- that's why /a/ sits right of /i/.
 */
export const QUAD = {
  topLeft: 0.0,
  topRight: 1.0,
  bottomLeft: 0.375,
  bottomRight: 1.0,
};

/** Map normalized (backness, height) to the slanted quad's x coordinate. */
export function quadX(backness, height) {
  const left = QUAD.topLeft + (QUAD.bottomLeft - QUAD.topLeft) * height;
  const right = QUAD.topRight + (QUAD.bottomRight - QUAD.topRight) * height;
  return left + (right - left) * backness;
}

const R = { close: 0, nearClose: 1 / 6, closeMid: 2 / 6, mid: 3 / 6, openMid: 4 / 6, nearOpen: 5 / 6, open: 1 };

/**
 * Vowel nodes. `s` lists [unrounded, rounded] where a pair exists.
 * Note: F1/F2 alone can't cleanly separate a rounded/unrounded pair (rounding
 * mostly just lowers F2), so both symbols are shown at each node.
 */
export const VOWELS = [
  { x: 0.0, y: R.close,     s: ['i', 'y'] },
  { x: 0.5, y: R.close,     s: ['ɨ', 'ʉ'] },
  { x: 1.0, y: R.close,     s: ['ɯ', 'u'] },
  { x: 0.2, y: R.nearClose, s: ['ɪ', 'ʏ'] },
  { x: 0.8, y: R.nearClose, s: ['ʊ'] },
  { x: 0.0, y: R.closeMid,  s: ['e', 'ø'] },
  { x: 0.5, y: R.closeMid,  s: ['ɘ', 'ɵ'] },
  { x: 1.0, y: R.closeMid,  s: ['ɤ', 'o'] },
  { x: 0.5, y: R.mid,       s: ['ə'] },
  { x: 0.0, y: R.openMid,   s: ['ɛ', 'œ'] },
  { x: 0.5, y: R.openMid,   s: ['ɜ', 'ɞ'] },
  { x: 1.0, y: R.openMid,   s: ['ʌ', 'ɔ'] },
  { x: 0.0, y: R.nearOpen,  s: ['æ'] },
  { x: 0.5, y: R.nearOpen,  s: ['ɐ'] },
  { x: 0.0, y: R.open,      s: ['a', 'ɶ'] },
  { x: 1.0, y: R.open,      s: ['ɑ', 'ɒ'] },
];

/** Rows that get a horizontal guide line drawn across the quad. */
export const ROWS = [
  { y: R.close,    label: 'Close' },
  { y: R.closeMid, label: 'Close-mid' },
  { y: R.openMid,  label: 'Open-mid' },
  { y: R.open,     label: 'Open' },
];

export const COLS = [
  { x: 0.0, label: 'Front' },
  { x: 0.5, label: 'Central' },
  { x: 1.0, label: 'Back' },
];

/**
 * Speaker calibration presets: reference F1/F2 for the four corners of the
 * vowel space. Roughly Peterson-Barney averages.
 */
export const PRESETS = {
  male: {
    closeFront: [280, 2250], closeBack: [310, 870],
    openFront: [690, 1660], openBack: [730, 1090],
  },
  female: {
    closeFront: [310, 2790], closeBack: [370, 950],
    openFront: [860, 2050], openBack: [850, 1220],
  },
  child: {
    closeFront: [370, 3200], closeBack: [430, 1170],
    openFront: [1010, 2320], openBack: [1030, 1370],
  },
};

export const CORNERS = [
  { key: 'closeFront', symbol: 'i', prompt: '“ee” as in heed' },
  { key: 'closeBack',  symbol: 'u', prompt: '“oo” as in who' },
  { key: 'openFront',  symbol: 'a', prompt: '“a” as in cat' },
  { key: 'openBack',   symbol: 'ɑ', prompt: '“ah” as in father' },
];

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Turn the four corner references into Bark-space anchors.
 *   height   <- Bark(F1)
 *   backness <- Bark(F2) - Bark(F1)
 * That difference is far more speaker-robust than raw F2, but its usable range
 * shrinks sharply as vowels open (a high F1 crowds F2), so each corner keeps
 * its own anchor rather than sharing one front/back pair.
 */
export function buildCalibration(ref) {
  const anchor = ([f1, f2]) => ({ b1: hzToBark(f1), d: hzToBark(f2) - hzToBark(f1) });
  return {
    ref,
    cf: anchor(ref.closeFront),
    cb: anchor(ref.closeBack),
    of: anchor(ref.openFront),
    ob: anchor(ref.openBack),
  };
}

// How far outside the quad a reading is allowed to report.
const LIMIT = 0.3;

const EPS = 1e-6;
const safeDiv = (num, den) => (Math.abs(den) < EPS ? 0 : num / den);

/**
 * F1/F2 (Hz) -> normalized {backness, height}.
 *
 * Height and backness are mutually dependent -- the F1 range depends on where
 * you are front-to-back, and the F2-F1 range depends on how open you are -- so
 * this is a bilinear inverse, solved by a few fixed-point iterations. Results
 * are left slightly unclamped so extreme vowels still read as past the edge.
 */
export function formantsToChart(f1, f2, cal) {
  const b1 = hzToBark(f1);
  const d = hzToBark(f2) - hzToBark(f1);

  // Iterate with wide bounds. Clamping tightly *inside* the loop makes the
  // fixed point oscillate once a coordinate saturates, which shows up as
  // cursor jitter on extreme vowels; the output is clamped instead.
  const WIDE = 1.5;
  let backness = 0.5;
  let height = 0.5;
  const settleHeight = (s) => {
    const closeB1 = lerp(cal.cf.b1, cal.cb.b1, s);
    const openB1 = lerp(cal.of.b1, cal.ob.b1, s);
    return clamp(safeDiv(b1 - closeB1, openB1 - closeB1), -WIDE, WIDE);
  };
  for (let i = 0; i < 4; i++) {
    height = settleHeight(backness);
    const frontD = lerp(cal.cf.d, cal.of.d, height);
    const backD = lerp(cal.cb.d, cal.ob.d, height);
    backness = clamp(safeDiv(frontD - d, frontD - backD), -WIDE, WIDE);
  }
  // Re-settle height against the final backness so the pair is consistent.
  height = settleHeight(backness);

  return {
    backness: clamp(backness, -LIMIT, LIMIT + 1),
    height: clamp(height, -LIMIT, LIMIT + 1),
  };
}

/** Nearest chart node, for the big "what am I saying" readout. */
export function nearestVowel(backness, height) {
  let best = null;
  let bestD = Infinity;
  for (const v of VOWELS) {
    // Compare in slanted-quad space so the geometry matches what's drawn.
    const dx = quadX(backness, height) - quadX(v.x, v.y);
    const dy = height - v.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = v; }
  }
  return { vowel: best, distance: Math.sqrt(bestD) };
}
