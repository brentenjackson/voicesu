// Learned readouts exported by the research code, and the MFCC engine that
// uses one. Weights are plain JSON so the browser needs no ML runtime.

import { MedianFilter } from '../dsp.js';
import { Mfcc } from '../mfcc.js';

/** Inverse of hzToBark (Traunmuller). */
export function barkToHz(z) {
  return (1960 * (z + 0.53)) / (26.28 - z);
}

/**
 * Apply an exported ridge readout: standardize the input, then one dot
 * product per target. Targets are formants in Bark.
 *   { inputMean: [D], inputScale: [D], coef: [[D] per target], intercept: [T] }
 */
export function applyLinearReadout(w, x) {
  const D = w.inputMean.length;
  const out = new Float64Array(w.coef.length);
  for (let t = 0; t < w.coef.length; t++) {
    let s = w.intercept[t];
    const row = w.coef[t];
    for (let d = 0; d < D; d++) s += row[d] * ((x[d] - w.inputMean[d]) / w.inputScale[d]);
    out[t] = s;
  }
  return out;
}

/** Lower-triangular Cholesky factor of a symmetric positive-definite matrix. */
function cholesky(A) {
  const n = A.length;
  const L = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      L[i][j] = i === j ? Math.sqrt(s) : s / L[j][j];
    }
  }
  return L;
}

/**
 * Gaussian mixture regression, E[y | x] under a joint mixture of (x, y):
 *   { kind: 'gmr', inputMean, inputScale, dx, weights: [K], means: [K][dx+dy],
 *     covariances: [K][dx+dy][dx+dy] }
 * Each component's Cholesky factor is prepared once and cached on the object.
 */
export function applyGmrReadout(w, x) {
  const dx = w.dx;
  const dy = w.means[0].length - dx;
  if (!w._prep) {
    w._prep = w.covariances.map((S, k) => {
      const Sxx = S.slice(0, dx).map((row) => row.slice(0, dx));
      const L = cholesky(Sxx);
      let logDet = 0;
      for (let i = 0; i < dx; i++) logDet += 2 * Math.log(L[i][i]);
      return { L, logDet, Syx: S.slice(dx).map((row) => row.slice(0, dx)), logW: Math.log(w.weights[k]) };
    });
  }
  const xs = new Float64Array(dx);
  for (let d = 0; d < dx; d++) xs[d] = (x[d] - w.inputMean[d]) / w.inputScale[d];

  const logResp = [], cond = [];
  for (let k = 0; k < w._prep.length; k++) {
    const { L, logDet, Syx, logW } = w._prep[k];
    const mu = w.means[k];
    // z = L^-1 (x - mu_x), then v = L^-T z = Sxx^-1 (x - mu_x)
    const z = new Float64Array(dx);
    for (let i = 0; i < dx; i++) {
      let s = xs[i] - mu[i];
      for (let j = 0; j < i; j++) s -= L[i][j] * z[j];
      z[i] = s / L[i][i];
    }
    const v = new Float64Array(dx);
    for (let i = dx - 1; i >= 0; i--) {
      let s = z[i];
      for (let j = i + 1; j < dx; j++) s -= L[j][i] * v[j];
      v[i] = s / L[i][i];
    }
    let maha = 0;
    for (let i = 0; i < dx; i++) maha += z[i] * z[i];
    logResp.push(logW - 0.5 * maha - 0.5 * logDet);
    const c = new Float64Array(dy);
    for (let t = 0; t < dy; t++) {
      let s = mu[dx + t];
      for (let i = 0; i < dx; i++) s += Syx[t][i] * v[i];
      c[t] = s;
    }
    cond.push(c);
  }
  const top = Math.max(...logResp);
  let total = 0;
  const resp = logResp.map((l) => { const r = Math.exp(l - top); total += r; return r; });
  const out = new Float64Array(dy);
  for (let k = 0; k < cond.length; k++) {
    for (let t = 0; t < dy; t++) out[t] += (resp[k] / total) * cond[k][t];
  }
  return out;
}

/** Dispatch on the exported readout's kind ('linear' when unspecified). */
export function applyReadout(w, x) {
  return w.kind === 'gmr' ? applyGmrReadout(w, x) : applyLinearReadout(w, x);
}

/** Same median + exponential smoothing the LPC engine applies, for a fair look. */
export class FormantSmoother {
  constructor(smoothing = 0.35, medianSize = 5) {
    this.smoothing = smoothing;
    this.f1Med = new MedianFilter(medianSize);
    this.f2Med = new MedianFilter(medianSize);
    this.f1 = 0;
    this.f2 = 0;
  }
  push(f1raw, f2raw) {
    const f1 = this.f1Med.push(f1raw);
    const f2 = this.f2Med.push(f2raw);
    const k = this.smoothing;
    this.f1 = this.f1 ? this.f1 * k + f1 * (1 - k) : f1;
    this.f2 = this.f2 ? this.f2 * k + f2 * (1 - k) : f2;
    return [this.f1, this.f2];
  }
  gap() { this.f1Med.reset(); this.f2Med.reset(); }
  reset() { this.gap(); this.f1 = 0; this.f2 = 0; }
}

export class MfccEngine {
  /**
   * @param {number} sr  analysis sample rate (the readout was trained at weights.sampleRate)
   * @param {object} weights  JSON from the research export: { features: {...}, readout: {...} },
   *                          readout kind 'linear' (ridge) or 'gmr'
   */
  constructor(sr, weights) {
    this.name = 'mfcc';
    this.label = 'MFCC';
    this.sr = sr;
    this.weights = weights;
    this.mfcc = new Mfcc(sr, weights.features);
    this.smoother = new FormantSmoother();
  }

  /** Formants in Hz for one frame, without smoothing. */
  predict(frame) {
    const bark = applyReadout(this.weights.readout, this.mfcc.compute(frame));
    return { f1: barkToHz(bark[0]), f2: barkToHz(bark[1]), f3: bark.length > 2 ? barkToHz(bark[2]) : 0 };
  }

  process(frame, voicing) {
    if (!voicing.voiced) {
      this.smoother.gap();
      return { f1: this.smoother.f1, f2: this.smoother.f2, f3: 0, confidence: 0, updated: false };
    }
    const p = this.predict(frame);
    const [f1, f2] = this.smoother.push(p.f1, p.f2);
    return { f1, f2, f3: p.f3, confidence: voicing.clarity, updated: true };
  }

  reset() { this.smoother.reset(); }
}
