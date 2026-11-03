// Per-engine calibration: each engine's four corner references, persisted,
// and the corner capture that fills them in.
//
// Engines disagree systematically -- the MFCC readout's /i/ is not LPC's /i/
// -- so one shared calibration would leave every cursor but one off its
// corners. Each engine gets its own; a capture records them all at once.

import { PRESETS, CORNERS } from './vowels.js';

const KEY = 'voicesu.calibration.v1';

/** Fewest fresh estimates an engine needs during a capture to set a corner. */
export const MIN_FRAMES = 8;

/** LPC keeps the original key, so calibrations saved before engines existed still load. */
export function storageKey(engine) {
  return engine === 'lpc' ? KEY : `${KEY}.${engine}`;
}

/** One engine's saved corner references, or the male preset. */
export function loadCalibration(engine, storage) {
  try {
    const raw = (storage ?? localStorage).getItem(storageKey(engine));
    const ref = raw && JSON.parse(raw);
    if (isRef(ref)) return ref;
  } catch { /* private mode or a corrupt entry: fall through to the preset */ }
  return PRESETS.male;
}

export function saveCalibration(engine, ref, storage) {
  try {
    (storage ?? localStorage).setItem(storageKey(engine), JSON.stringify(ref));
  } catch { /* private mode */ }
}

const isRef = (ref) => !!ref && CORNERS.every(({ key }) =>
  Array.isArray(ref[key]) && ref[key].length === 2 && ref[key].every(Number.isFinite));

/**
 * Hold one vowel for a few seconds. Every engine that was on keeps its own
 * samples, and each gets the median of them as that corner.
 */
export class CornerCapture {
  /**
   * @param {object} corner   entry from CORNERS
   * @param {string[]} names  engines to record
   * @param {number} until    performance.now() deadline, for the countdown
   */
  constructor(corner, names, until) {
    this.corner = corner;
    this.until = until;
    this.frames = 0; // voiced frames seen
    this.samples = Object.fromEntries(names.map((name) => [name, []]));
  }

  /** One analysis frame of tracker state: { voiced, results: { name: Result } }. */
  push(state) {
    if (!state.voiced) return;
    this.frames++;
    for (const [name, list] of Object.entries(this.samples)) {
      const r = state.results[name];
      // Fresh estimates only: an engine coasting on its last value, or an
      // async one between inferences, would otherwise count the same one twice.
      if (r && r.updated && r.f1 && r.f2) list.push([r.f1, r.f2]);
    }
  }

  /** { name: [F1, F2] } medians; null for an engine with too few estimates. */
  medians() {
    const out = {};
    for (const [name, list] of Object.entries(this.samples)) {
      out[name] = list.length < MIN_FRAMES
        ? null
        : [median(list.map((p) => p[0])), median(list.map((p) => p[1]))];
    }
    return out;
  }
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
