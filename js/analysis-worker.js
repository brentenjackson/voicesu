// Analysis worker: frames the captured audio at a fixed hop and runs the
// voicing gate and the synchronous engines, off the main thread.
//
//   main -> worker  { type: 'init', sr, decim, engines: [{ name, assets }],
//                     enabled, gate, smoothing, sendFrames, port,
//                     backend: 'js' | 'wasm', dspModule }
//                   { type: 'configure', enabled?, gate?, smoothing?, sendFrames?, backend? }
//   port -> worker  Float32Array chunks of hardware-rate audio, from the worklet
//   worker -> main  { type: 'ready', backend, errors: { name: message } }
//                   { type: 'frame', voicing, results, ms, backend, frame? }
//                   { type: 'backend', backend, errors }   after a switch
//
// `ms` is the time the analysis of that frame took here (voicing plus every
// enabled engine), for the live readout. `backend` picks JavaScript or the
// WebAssembly build of the per-frame pipeline (js/engines/wasm.js); it can
// change while running, which rebuilds the engines on the other back end.
//
// `frame` (a copy of the analysis frame) is only sent while the main thread
// asks for it: ownAudio engines live there and still take process(frame, voicing).

import { Framer, HOP_SECONDS } from './framer.js';
import { Analyzer } from './analysis.js';
import { ENGINES } from './engines/registry.js';
import { WasmDsp } from './engines/wasm.js';

let analyzer = null;
let backend = 'js';
let sendFrames = false;
let setup = null;   // the init message, kept to rebuild engines on a switch
let wasm = null;    // WasmDsp, instantiated the first time it's needed

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') init(msg);
  else if (msg.type === 'configure') {
    analyzer.configure(msg);
    if (msg.sendFrames !== undefined) sendFrames = msg.sendFrames;
    if (msg.backend && msg.backend !== backend) switchBackend(msg.backend);
  }
};

async function init(msg) {
  setup = msg;
  const effSr = msg.sr / msg.decim;
  const built = await build(msg.backend ?? 'js', {
    gate: msg.gate, smoothing: msg.smoothing, enabled: msg.enabled,
  });
  ({ analyzer, backend } = built);
  sendFrames = msg.sendFrames;

  const framer = new Framer(msg.decim, effSr * HOP_SECONDS);
  msg.port.onmessage = (ev) => framer.push(ev.data, onFrame);
  self.postMessage({ type: 'ready', backend, errors: built.errors });
}

/**
 * An Analyzer with every engine built on one back end. Weights arrive in the
 * init message; one bad export shouldn't take the others down. If the
 * WebAssembly module can't be instantiated, this falls back to JavaScript and
 * says why.
 */
async function build(want, settings) {
  const effSr = setup.sr / setup.decim;
  const errors = {};
  let dsp = null;
  if (want === 'wasm') {
    try {
      wasm ??= await WasmDsp.create(setup.dspModule);
      dsp = wasm;
    } catch (err) {
      errors.backend = `WebAssembly unavailable (${err.message}); using JavaScript`;
    }
  }
  const next = new Analyzer(effSr, dsp);
  next.configure({ gate: settings.gate, smoothing: settings.smoothing });
  for (const { name, assets } of setup.engines) {
    const spec = ENGINES.find((s) => s.name === name);
    try {
      next.add(spec, spec.create(effSr, assets, dsp));
    } catch (err) {
      errors[name] = err.message;
    }
  }
  next.configure({ enabled: settings.enabled });
  return { analyzer: next, backend: dsp ? 'wasm' : 'js', errors };
}

async function switchBackend(want) {
  const built = await build(want, {
    gate: analyzer.gate, smoothing: analyzer.smoothing, enabled: [...analyzer.enabled],
  });
  ({ analyzer, backend } = built);
  self.postMessage({ type: 'backend', backend, errors: built.errors });
}

function onFrame(frame) {
  const t0 = performance.now();
  const { voicing, results } = analyzer.analyze(frame);
  const ms = performance.now() - t0;
  if (sendFrames) {
    const copy = frame.slice();
    self.postMessage({ type: 'frame', voicing, results, ms, backend, frame: copy }, [copy.buffer]);
  } else {
    self.postMessage({ type: 'frame', voicing, results, ms, backend });
  }
}
