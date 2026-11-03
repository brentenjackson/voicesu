// Source-filter vowel synthesis shared by the unit tests.

/**
 * Source-filter synthesis of a vowel:
 *   impulse train -> glottal shaping (-12 dB/oct) -> formant resonators
 *   -> lip radiation (+6 dB/oct)
 * The tilt matters: pre-emphasis in the analyzer assumes this -6 dB/oct net
 * slope, so a flat impulse train would bias the low poles upward.
 */
export function synth(formants, f0, n, sr) {
  const len = n + 4000;
  const x = new Float64Array(len);
  const period = Math.round(sr / f0);
  for (let i = 0; i < len; i += period) x[i] = 1;

  // Glottal source: two coincident real poles near DC.
  const g = Math.exp((-2 * Math.PI * 100) / sr);
  let sig = x;
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float64Array(len);
    for (let i = 0; i < len; i++) out[i] = sig[i] + g * (out[i - 1] || 0);
    sig = out;
  }

  // Vocal tract: one two-pole resonator per formant.
  for (const { f, bw } of formants) {
    const r = Math.exp((-Math.PI * bw) / sr);
    const theta = (2 * Math.PI * f) / sr;
    const a1 = -2 * r * Math.cos(theta);
    const a2 = r * r;
    const gain = 1 + a1 + a2;
    const out = new Float64Array(len);
    for (let i = 0; i < len; i++) {
      out[i] = gain * sig[i] - a1 * (out[i - 1] || 0) - a2 * (out[i - 2] || 0);
    }
    sig = out;
  }

  // Lip radiation: first difference.
  const rad = new Float64Array(len);
  for (let i = 1; i < len; i++) rad[i] = sig[i] - sig[i - 1];

  return rad.subarray(len - n); // drop the startup transient
}

/** Scale to a peak of `peak`. */
export function normalize(x, peak = 1) {
  let max = 0;
  for (const v of x) max = Math.max(max, Math.abs(v));
  return Float64Array.from(x, (v) => (v / max) * peak);
}
