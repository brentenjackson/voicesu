// Mel-frequency cepstral coefficients for one analysis frame.
//
// Shared by the MFCC engine in the browser and the offline research harness,
// which computes the training features with this exact code.

/** In-place iterative radix-2 FFT. `re` and `im` have power-of-two length. */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

const hzToMel = (f) => 2595 * Math.log10(1 + f / 700);
const melToHz = (m) => 700 * (10 ** (m / 2595) - 1);

/** Triangular mel filters (HTK mel scale) over the bins of an nfft-point FFT. */
export function melFilterbank(nfft, sr, nMels, fMin, fMax) {
  const nBins = nfft / 2 + 1;
  const lo = hzToMel(fMin), hi = hzToMel(fMax);
  const edges = [];
  for (let m = 0; m < nMels + 2; m++) edges.push(melToHz(lo + ((hi - lo) * m) / (nMels + 1)));
  const filters = [];
  for (let m = 0; m < nMels; m++) {
    const [left, center, right] = [edges[m], edges[m + 1], edges[m + 2]];
    const w = new Float64Array(nBins);
    for (let k = 0; k < nBins; k++) {
      const f = (k * sr) / nfft;
      if (f > left && f < right) {
        w[k] = f <= center ? (f - left) / (center - left) : (right - f) / (right - center);
      }
    }
    filters.push(w);
  }
  return filters;
}

export const MFCC_DEFAULTS = {
  nfft: 512,
  nMels: 40,
  nCoeffs: 20, // c1..c20; c0 (overall level) is dropped
  fMin: 60,
  fMax: 5000,
  preEmphasis: 0.97,
};

export class Mfcc {
  constructor(sr, opts = {}) {
    this.sr = sr;
    this.opts = { ...MFCC_DEFAULTS, ...opts };
    const { nfft, nMels, fMin, fMax } = this.opts;
    this.filters = melFilterbank(nfft, sr, nMels, fMin, Math.min(fMax, sr / 2));
    this.window = null;
    this.re = new Float64Array(nfft);
    this.im = new Float64Array(nfft);
  }

  /** c1..cN for one frame. Frames shorter than nfft are zero-padded. */
  compute(frame) {
    const { nfft, nMels, nCoeffs, preEmphasis } = this.opts;
    const n = Math.min(frame.length, nfft);
    if (!this.window || this.window.length !== n) {
      this.window = new Float64Array(n);
      for (let i = 0; i < n; i++) this.window[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
    }
    const { re, im } = this;
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < n; i++) {
      const x = i > 0 ? frame[i] - preEmphasis * frame[i - 1] : frame[i];
      re[i] = x * this.window[i];
    }
    fft(re, im);

    const logMel = new Float64Array(nMels);
    for (let m = 0; m < nMels; m++) {
      const w = this.filters[m];
      let e = 0;
      for (let k = 0; k < w.length; k++) if (w[k]) e += w[k] * (re[k] * re[k] + im[k] * im[k]);
      logMel[m] = Math.log(e + 1e-10);
    }

    // Orthonormal DCT-II; a constant gain on the frame only moves c0.
    const out = new Float64Array(nCoeffs);
    const scale = Math.sqrt(2 / nMels);
    for (let c = 1; c <= nCoeffs; c++) {
      let s = 0;
      for (let m = 0; m < nMels; m++) s += logMel[m] * Math.cos((Math.PI * c * (m + 0.5)) / nMels);
      out[c - 1] = s * scale;
    }
    return out;
  }
}
