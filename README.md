# voicesu

Real-time IPA vowel tracker in the browser. Speak into the mic and a cursor
glides around the IPA vowel quadrilateral to whatever vowel you're producing.

Step one toward an osu-style rhythm game where the beatmap is a vowel chart.

## Run

```sh
./serve.py          # or: python3 -m http.server 8000
```

Open <http://localhost:8000>. `localhost` is a secure context, so the mic
prompt works over plain HTTP — a LAN IP will not.

Click **Start microphone**, then calibrate (see below).

## How it works

1. **Capture** — `getUserMedia` with echo cancellation, noise suppression and
   AGC turned *off*; all three mangle formant structure. Audio is highpassed at
   60 Hz and lowpassed at ~5.2 kHz in the Web Audio graph (`js/tracker.js`).
2. **Framing, off the main thread** — an `AudioWorklet` copies the filtered
   signal straight to a module `Worker`, which decimates it to ~11 kHz and cuts
   the latest 512 samples every 1/60 s (`js/framer.js`). The worker runs the
   voicing gate and the engines and posts results back; the main thread only
   draws. The research harness emulates exactly this framing, so offline
   numbers are numbers for the demo. Browsers without `AudioWorklet` or module
   Workers fall back to pulling the frame from an `AnalyserNode` once per
   animation frame, as voicesu originally did.
3. **Voicing gate** — normalized autocorrelation gives F0 and a clarity score.
   Below the RMS/clarity thresholds the cursors coast, so fricatives and room
   noise don't fling them around. It's measured once per frame and shared, so
   every engine gates together.
4. **Engines** — each estimates F1 and F2 from the frame, and every engine
   that's switched on gets its own cursor and readout row
   (`js/engines/index.js` documents the interface):
   - **LPC** (default) — pre-emphasis → Hamming window → autocorrelation →
     Levinson–Durbin, order ≈ 13. The all-pole model is the vocal tract's
     resonances (`js/dsp.js`). The LPC polynomial is root-solved with
     Durand–Kerner; each conjugate pole pair is a resonance, frequency from its
     angle, bandwidth from its radius. Poles are filtered to 150–5000 Hz with
     bandwidth < 500 Hz, then sorted; the lowest two are F1 and F2.
   - **MFCC** — mel-cepstral coefficients (`js/mfcc.js`) through a readout
     (ridge or Gaussian-mixture regression) trained offline by the research
     code, loaded from
     `models/mfcc_readout.json`. Until those weights are exported its toggle
     is greyed out.
   - **wav2vec 2.0** — a ridge probe on frozen `wav2vec2-base`, read at the
     transformer's input (layer 0, the best layer in the research
     cross-validation). The model is cut there and exported with the readout
     inside one ONNX graph (`models/w2v2_probe.onnx`, ~37 MB): 400 ms of
     16 kHz audio in, F1/F2 in Bark out. The engine runs its own 16 kHz
     `AudioContext` and AudioWorklet (`js/engines/w2v2-capture.js`) and asks a
     worker (`js/engines/w2v2-worker.js`, onnxruntime-web 1.20.1 from the
     jsDelivr CDN, WebAssembly) for an estimate every 100 ms; about 75 ms per
     estimate on one thread in Chrome. Off by default; its cursor shows the
     latest finished estimate.

   LPC and MFCC both finish with a 5-frame median plus exponential smoothing:
   it removes the outliers root-solving occasionally produces, and applying it
   to both keeps the comparison fair. The big nearest-vowel readout follows
   whichever engine you pick as primary.

   What the demo offers lives in `js/engines/registry.js`: a name, how to
   load what the engine needs, and how to build it. Synchronous engines are
   built inside the worker from the loaded weights; engines with their own
   audio stay on the main thread, the only place the `MediaStream` exists, and
   get `start(stream)` when the mic starts.
5. **Mapping** — F1 and F2 go to the Bark scale, then:
   - **height** (close↔open) from `Bark(F1)`
   - **backness** (front↔back) from `Bark(F2) − Bark(F1)`

   That difference is used rather than raw F2 because it's markedly more
   speaker-robust.

   The catch is that the two axes are *coupled*: the usable range of
   `F2 − F1` collapses as vowels open, because a high F1 crowds F2 from below.
   For the male preset it spans 10.98→4.58 Bark at the close end but only
   5.31→2.31 at the open end. The vowel space is a wedge, not a rectangle — so
   normalizing backness against a single front/back pair pushes /ɑ/ clean off
   the back edge and drags front-open /æ/ toward the back.

   Instead all four corners keep their own anchors, and position is recovered
   by a bilinear inverse: height depends on backness, backness depends on
   height, solved with a few fixed-point iterations (`js/vowels.js`).

## Calibration

Vocal tract length dominates absolute formant values, so the defaults will be
wrong for most people. The chart is anchored on four corners — hold each for
~2.5 s and the median of every voiced frame becomes that corner:

| button | vowel | corner |
| --- | --- | --- |
| “ee” as in heed | [i] | close front |
| “oo” as in who | [u] | close back |
| “a” as in cat | [a] | open front |
| “ah” as in father | [ɑ] | open back |

Every engine is calibrated separately, because they disagree systematically —
the MFCC readout's [i] is not LPC's [i] — and one shared set of corners would
leave all but one cursor off the chart's corners. A capture records the median
for every engine that's switched on, at once.

Saved to `localStorage`, one entry per engine; LPC keeps the original
`voicesu.calibration.v1` key, so a calibration from before engines existed
carries over. The presets are Peterson–Barney averages and are a reasonable
starting point if you'd rather not calibrate; picking one sets it for every
engine.

## Known limits

- **Rounding is largely invisible.** /i/ vs /y/ differ mostly in F2, which is
  also the backness axis — so /y/ reads as centralized rather than as a
  distinct point. Each node shows both symbols for this reason. Separating them
  properly needs F3.
- **High-pitched voices are harder.** Widely spaced harmonics undersample the
  spectral envelope and LPC starts locking onto individual harmonics rather
  than formants. Sopranos and children will be noisier.
- **The fallback isn't the research path.** Without `AudioWorklet`, frames
  arrive at the display's refresh rate rather than every 1/60 s, and the
  decimation phase wanders with the analyser's buffer. Tracking is the same to
  the eye, but its numbers won't match the research harness sample for sample.
- **Engines with their own audio live on the main thread**, not in the
  worker, because a worker can't hold the `MediaStream`. Their `process()` is
  just a lookup, so keeping their inference off the main thread is up to the
  engine.
- **wav2vec 2.0 needs the network once.** onnxruntime-web comes from a CDN,
  and the ONNX file is not in git (`.gitignore`); regenerate it with the
  research code's `scripts/export_demo_models.py`.
- **No weights, no MFCC.** The engine needs `models/mfcc_readout.json` from the
  research code; until it exists the toggle stays disabled. A file of the
  wrong shape is refused with a note when the mic starts, rather than drawing
  nonsense.

## Tests

```sh
npm test           # DSP + mapping, no browser needed
npm run test:e2e   # drives the real page in headless Chrome
test/w2v2-bench.sh # times the wav2vec 2.0 graph in headless Chrome
```

`npm test` synthesizes vowels through a source-filter model (impulse train →
glottal shaping → resonators → lip radiation) and asserts the tracker recovers
the formants it was given, across F0 from 100–220 Hz and on both the native
11 kHz path and the 48 kHz decimation fallback. It also checks the mapping pins
the calibration corners exactly, puts Peterson–Barney vowels in the right
regions, and stays monotonic in both axes. Then it runs the capture pipeline
without a browser — framing cadence, decimation, both engines through the
analyzer, the worker's messages, the bookkeeping for engines with their own
audio — and per-engine calibration storage and capture.

`npm run test:e2e` feeds Chrome a WAV of synthesized /i/, /ɑ/, /u/ as a fake
microphone, drives the page over the DevTools Protocol, and asserts the live
readouts track each vowel. It loads the page four ways: as shipped (checking
MFCC too if `models/mfcc_readout.json` exists); with a tiny fixture served in
its place, to exercise the MFCC plumbing, the legend, the primary picker,
per-engine calibration and the sliders; with the 11 kHz context refused, so the
worker decimates; and with `AudioWorkletNode` removed, so the main-thread
fallback runs. Pass a path to save a screenshot of both cursors. It skips
cleanly if no Chrome is installed.

## Layout

| file | role |
| --- | --- |
| `js/dsp.js` | LPC, root finding, pitch, filters — no DOM, no audio API |
| `js/mfcc.js` | MFCC features, shared with the research harness |
| `js/engines/` | The engine interface (`index.js`), LPC, the MFCC readout, and `registry.js`: which engines the demo offers |
| `js/tracker.js` | Mic graph; picks worklet + worker or the main-thread fallback |
| `js/capture-worklet.js` | `AudioWorkletProcessor`: copies the filtered signal to the worker |
| `js/analysis-worker.js` | Worker: frames the audio, runs the voicing gate and engines |
| `js/framer.js` | Fixed-hop framing and decimation — the contract the research harness emulates |
| `js/analysis.js` | One frame through the voicing gate and every enabled engine, in the worker or not |
| `js/vowels.js` | Chart geometry, vowel inventory, formant→position mapping |
| `js/calibration.js` | Per-engine calibration storage and corner capture |
| `js/chart.js` | Canvas rendering: quadrilateral, a cursor and trail per engine, spectrum |
| `js/main.js` | UI wiring: engine toggles and readouts, calibration flow, pilot mode, animation loop |
| `js/engines/w2v2*.js` | wav2vec 2.0 engine: its 16 kHz capture worklet and the onnxruntime-web worker |
| `js/pilot.js` | Pilot mode: logs per-frame engine F1/F2 and pitch (never audio) for the classmate study |
| `models/` | Exported by the research code: `mfcc_readout.json`, `w2v2_probe.json`, `w2v2_probe.onnx` (not in git) |
| `test/` | Unit tests, plus the CDP browser harness and its fixtures |
