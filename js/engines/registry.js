// The engines the demo offers, and how to build each one.
//
// Adding an engine is one entry here plus a color in ENGINE_COLORS (index.js):
//   name, label    as on the engine itself, but needed before it exists
//   defaultOn      whether its toggle starts checked
//   load()         optional, async: fetch what it needs (weights, a module).
//                  Runs on the main thread, so URLs are relative to the page.
//                  If it throws, the toggle shows disabled with `unavailable`.
//   create(sr, assets)    build it at the analysis rate, given load()'s result
//   setSmoothing(engine, k)    optional: apply the "Formant smoothing" slider
//   ownAudio       true for engines with async start(mediaStream)/stop()
//
// Synchronous engines -- process() does the work -- are built inside the
// analysis worker from `assets`, so `create` must not touch the DOM and
// `assets` must survive postMessage. Engines with `ownAudio` stay on the main
// thread, the only place a MediaStream exists; their process() just hands back
// the latest finished estimate, so calling it there costs nothing.

import { LpcEngine } from './lpc.js';
import { MfccEngine } from './readout.js';
import { MFCC_DEFAULTS } from '../mfcc.js';

export const ENGINES = [
  {
    name: 'lpc',
    label: 'LPC',
    defaultOn: true,
    create: (sr) => new LpcEngine(sr),
    setSmoothing: (engine, k) => { engine.smoothing = k; },
  },
  {
    name: 'mfcc',
    label: 'MFCC',
    defaultOn: true,
    load: () => fetchJson('models/mfcc_readout.json'),
    unavailable: 'weights not exported yet',
    create: (sr, weights) => new MfccEngine(sr, checkMfccWeights(weights)),
    setSmoothing: (engine, k) => { engine.smoother.smoothing = k; },
  },
  // wav2vec 2.0 brings its own 16 kHz capture, so it is an ownAudio engine.
  // load() only checks the exported probe is there (the ONNX file itself is
  // fetched by start()); off by default, since it loads ~37 MB.
  {
    name: 'w2v2',
    label: 'wav2vec 2.0',
    defaultOn: false,
    ownAudio: true,
    load: async () => {
      await fetchJson('models/w2v2_probe.json');
      return import('./w2v2.js');
    },
    unavailable: 'probe not exported yet',
    create: (sr, mod) => new mod.W2v2Engine(),
    setSmoothing: (engine, k) => { engine.smoother.smoothing = k; },
  },
];

/**
 * Run every engine's load(). Never throws: a failed load just marks that
 * engine unavailable. Resolves to [{ spec, assets, available, note }].
 */
export function loadEngines(specs = ENGINES) {
  return Promise.all(specs.map(async (spec) => {
    try {
      const assets = spec.load ? await spec.load() : null;
      return { spec, assets, available: true, note: '' };
    } catch (err) {
      return { spec, assets: null, available: false, note: spec.unavailable ?? err.message };
    }
  }));
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/**
 * Every readout kind (ridge, GMR) standardizes its input with inputMean and
 * inputScale, so those must match the MFCC count the features produce. A
 * mismatch would otherwise show up as NaN readouts; thrown from create(), it
 * reaches the engine's row as "unavailable: ..." on either analysis path.
 * The rest of the readout is applyReadout()'s business.
 */
export function checkMfccWeights(w) {
  const r = w?.readout;
  const dims = { ...MFCC_DEFAULTS, ...w?.features }.nCoeffs;
  if (!r || r.inputMean?.length !== dims || r.inputScale?.length !== dims) {
    throw new Error(`weights malformed: readout takes ${r?.inputMean?.length ?? 'no'} inputs, features give ${dims}`);
  }
  return w;
}
