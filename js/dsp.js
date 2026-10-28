// Core DSP: LPC analysis, polynomial root finding, formant + pitch extraction.

/** Bark scale (Traunmuller). Perceptually linear-ish frequency axis. */
export function hzToBark(f) {
  return 26.81 * f / (1960 + f) - 0.53;
}

/** In-place pre-emphasis: boosts the ~6dB/oct spectral tilt of voiced speech. */
export function preEmphasis(x, alpha = 0.97) {
  const out = new Float64Array(x.length);
  out[0] = x[0];
  for (let i = x.length - 1; i > 0; i--) out[i] = x[i] - alpha * x[i - 1];
  return out;
}

export function hamming(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

export function rms(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}

/** Autocorrelation r[0..order]. */
function autocorr(x, order) {
  const r = new Float64Array(order + 1);
  for (let k = 0; k <= order; k++) {
    let s = 0;
    for (let n = k; n < x.length; n++) s += x[n] * x[n - k];
    r[k] = s;
  }
  return r;
}

/**
 * Levinson-Durbin recursion.
 * Returns prediction-error filter A(z) = 1 + a[1]z^-1 + ... + a[p]z^-p, plus gain.
 */
export function lpc(x, order) {
  const r = autocorr(x, order);
  if (r[0] <= 0) return null;
  // Ridge / white-noise correction keeps the recursion numerically stable.
  r[0] *= 1.0001;
  r[0] += 1e-9;

  const a = new Float64Array(order + 1);
  const prev = new Float64Array(order + 1);
  a[0] = 1;
  let err = r[0];

  for (let i = 1; i <= order; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const k = -acc / err;
    if (!isFinite(k)) return null;
    prev.set(a);
    for (let j = 1; j < i; j++) a[j] = prev[j] + k * prev[i - j];
    a[i] = k;
    err *= 1 - k * k;
    if (err <= 0) { err = 1e-12; break; }
  }
  return { a, gain: Math.sqrt(err) };
}

/**
 * Durand-Kerner root finder for a monic polynomial given in descending powers.
 * Order here is ~12-16, so this converges in a handful of iterations.
 */
export function polyRoots(coeffs) {
  const n = coeffs.length - 1;
  const re = new Float64Array(n);
  const im = new Float64Array(n);

  // Spiral initial guesses -- standard DK seeding.
  let pr = 1, pi = 0;
  const cr = 0.4, ci = 0.9;
  for (let i = 0; i < n; i++) {
    re[i] = pr; im[i] = pi;
    const nr = pr * cr - pi * ci;
    pi = pr * ci + pi * cr;
    pr = nr;
  }

  for (let iter = 0; iter < 120; iter++) {
    let maxStep = 0;
    for (let i = 0; i < n; i++) {
      // Horner evaluation of P(z_i)
      let vr = coeffs[0], vi = 0;
      for (let k = 1; k <= n; k++) {
        const t = vr * re[i] - vi * im[i] + coeffs[k];
        vi = vr * im[i] + vi * re[i];
        vr = t;
      }
      // prod_{j != i} (z_i - z_j)
      let dr = 1, di = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const ar = re[i] - re[j], ai = im[i] - im[j];
        const nr = dr * ar - di * ai;
        di = dr * ai + di * ar;
        dr = nr;
      }
      const den = dr * dr + di * di;
      if (den < 1e-300) continue;
      const qr = (vr * dr + vi * di) / den;
      const qi = (vi * dr - vr * di) / den;
      re[i] -= qr;
      im[i] -= qi;
      const step = Math.abs(qr) + Math.abs(qi);
      if (step > maxStep) maxStep = step;
    }
    if (maxStep < 1e-13) break;
  }
  return { re, im };
}

/**
 * Formants from LPC coefficients: each conjugate pole pair is a resonance.
 * freq = angle * sr / 2pi, bandwidth = -ln|z| * sr / pi.
 */
export function formantsFromLpc(a, sr, opts = {}) {
  const minF = opts.minF ?? 90;
  const maxF = opts.maxF ?? sr / 2 - 150;
  const maxBw = opts.maxBw ?? 500;

  // A(z) = 1 + a1 z^-1 + ... ; multiply by z^p -> descending-power coeffs.
  const coeffs = Array.from(a);
  const { re, im } = polyRoots(coeffs);

  const found = [];
  for (let i = 0; i < re.length; i++) {
    if (im[i] <= 0) continue; // one of each conjugate pair
    const mag = Math.hypot(re[i], im[i]);
    if (mag >= 1 || mag <= 0) continue; // unstable / degenerate
    const freq = (Math.atan2(im[i], re[i]) * sr) / (2 * Math.PI);
    const bw = (-Math.log(mag) * sr) / Math.PI;
    if (freq < minF || freq > maxF || bw > maxBw) continue;
    found.push({ freq, bw });
  }
  found.sort((p, q) => p.freq - q.freq);
  return found;
}

/**
 * Normalized-autocorrelation pitch detector. Also doubles as the voicing gate:
 * a strong periodic peak means we're looking at a vowel, not a fricative or noise.
 */
export function detectPitch(x, sr, fmin = 70, fmax = 400) {
  const minLag = Math.floor(sr / fmax);
  const maxLag = Math.min(Math.floor(sr / fmin), x.length - 1);
  if (maxLag <= minLag) return { f0: 0, clarity: 0 };

  let e0 = 0;
  for (let i = 0; i < x.length; i++) e0 += x[i] * x[i];
  if (e0 <= 0) return { f0: 0, clarity: 0 };

  let bestLag = -1, bestVal = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let num = 0, den = 0;
    for (let i = lag; i < x.length; i++) {
      num += x[i] * x[i - lag];
      den += x[i - lag] * x[i - lag];
    }
    const norm = num / (Math.sqrt(den * e0) + 1e-12);
    if (norm > bestVal) { bestVal = norm; bestLag = lag; }
  }
  if (bestLag < 0) return { f0: 0, clarity: 0 };
  return { f0: sr / bestLag, clarity: Math.max(0, Math.min(1, bestVal)) };
}

/** LPC spectral envelope magnitude (dB) over `bins` points from 0..sr/2. */
export function lpcEnvelope(a, gain, sr, bins) {
  const out = new Float32Array(bins);
  const p = a.length - 1;
  for (let b = 0; b < bins; b++) {
    const w = (Math.PI * b) / (bins - 1);
    let sre = 0, sim = 0;
    for (let k = 0; k <= p; k++) {
      sre += a[k] * Math.cos(w * k);
      sim -= a[k] * Math.sin(w * k);
    }
    const mag = gain / (Math.hypot(sre, sim) + 1e-12);
    out[b] = 20 * Math.log10(mag + 1e-12);
  }
  return out;
}

/** Running median -- kills the occasional wild formant outlier. */
export class MedianFilter {
  constructor(size = 5) { this.size = size; this.buf = []; }
  push(v) {
    this.buf.push(v);
    if (this.buf.length > this.size) this.buf.shift();
    const s = [...this.buf].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }
  reset() { this.buf.length = 0; }
}
