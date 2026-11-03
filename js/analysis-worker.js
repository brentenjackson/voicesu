// Analysis worker: frames the captured audio at a fixed hop and runs the
// voicing gate and the synchronous engines, off the main thread.
//
//   main -> worker  { type: 'init', sr, decim, engines: [{ name, assets }],
//                     enabled, gate, smoothing, sendFrames, port }
//                   { type: 'configure', enabled?, gate?, smoothing?, sendFrames? }
//   port -> worker  Float32Array chunks of hardware-rate audio, from the worklet
//   worker -> main  { type: 'ready', errors: { name: message } }
//                   { type: 'frame', voicing, results, frame? }
//
// `frame` (a copy of the analysis frame) is only sent while the main thread
// asks for it: ownAudio engines live there and still take process(frame, voicing).

import { Framer, HOP_SECONDS } from './framer.js';
import { Analyzer } from './analysis.js';
import { ENGINES } from './engines/registry.js';

let analyzer = null;
let sendFrames = false;

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') init(msg);
  else if (msg.type === 'configure') {
    analyzer.configure(msg);
    if (msg.sendFrames !== undefined) sendFrames = msg.sendFrames;
  }
};

function init(msg) {
  const effSr = msg.sr / msg.decim;
  analyzer = new Analyzer(effSr);
  analyzer.configure({ gate: msg.gate, smoothing: msg.smoothing });

  // Weights arrive in the init message; the engines are built here, once the
  // analysis rate is known. One bad export shouldn't take the others down.
  const errors = {};
  for (const { name, assets } of msg.engines) {
    const spec = ENGINES.find((s) => s.name === name);
    try {
      analyzer.add(spec, spec.create(effSr, assets));
    } catch (err) {
      errors[name] = err.message;
    }
  }
  analyzer.configure({ enabled: msg.enabled });
  sendFrames = msg.sendFrames;

  const framer = new Framer(msg.decim, effSr * HOP_SECONDS);
  msg.port.onmessage = (ev) => framer.push(ev.data, onFrame);
  self.postMessage({ type: 'ready', errors });
}

function onFrame(frame) {
  const { voicing, results } = analyzer.analyze(frame);
  if (sendFrames) {
    const copy = frame.slice();
    self.postMessage({ type: 'frame', voicing, results, frame: copy }, [copy.buffer]);
  } else {
    self.postMessage({ type: 'frame', voicing, results });
  }
}
