// Formant engines: the shared interface.
//
// Every engine estimates F1 and F2 from the microphone and exposes:
//
//   name     short id ('lpc', 'mfcc', 'w2v2')
//   label    display name
//   process(frame, voicing) -> Result
//            frame:   Float64Array, the latest 512 samples at the analysis rate
//                     (11,025 Hz when the browser grants it)
//            voicing: measureVoicing() output for the same frame
//                     ({ rms, f0, clarity, voiced }), computed once per frame
//                     and shared by every engine, so all cursors gate together
//   reset()  clear temporal state (median filters, smoothing)
//
//   Result:  { f1, f2, f3, confidence, updated }
//            f1/f2 in Hz (0 until the first estimate); `updated` is true when
//            this frame produced a new estimate; confidence in [0, 1].
//
// Engines that need their own audio (wav2vec 2.0 runs at 16 kHz on a longer
// window, asynchronously) also implement:
//
//   async start(mediaStream)   open their own capture
//   async stop()
//
// and process() returns their most recent finished estimate, so the render
// loop never waits on inference.

export { LpcEngine, measureVoicing, defaultLpcOrder } from './lpc.js';
export { MfccEngine, applyLinearReadout, barkToHz, FormantSmoother } from './readout.js';

/**
 * Fixed display color per engine: the same hues as the research figures, in
 * the palette's dark-surface steps since voicesu draws on a dark background.
 */
export const ENGINE_COLORS = {
  lpc: '#3987e5',
  mfcc: '#199e70',
  w2v2: '#c98500',
};
