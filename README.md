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
   60 Hz, lowpassed at ~5.2 kHz, and decimated to ~11 kHz (`js/tracker.js`).
2. **Voicing gate** — normalized autocorrelation gives F0 and a clarity score.
   Below the RMS/clarity thresholds the cursor coasts, so fricatives and room
   noise don't fling it around.
3. **LPC** — pre-emphasis → Hamming window → autocorrelation →
   Levinson–Durbin, order ≈ 13. The all-pole model is the vocal tract's
   resonances (`js/dsp.js`).
4. **Formants** — the LPC polynomial is root-solved with Durand–Kerner. Each
   conjugate pole pair is a resonance: frequency from its angle, bandwidth from
   its radius. Poles are filtered to 150–5000 Hz with bandwidth < 500 Hz, then
   sorted; the lowest two are F1 and F2. A 5-frame median plus exponential
   smoothing removes the outliers root-solving occasionally produces.
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

Saved to `localStorage`. The presets are Peterson–Barney averages and are a
reasonable starting point if you'd rather not calibrate.

## Known limits

- **Rounding is largely invisible.** /i/ vs /y/ differ mostly in F2, which is
  also the backness axis — so /y/ reads as centralized rather than as a
  distinct point. Each node shows both symbols for this reason. Separating them
  properly needs F3.
- **High-pitched voices are harder.** Widely spaced harmonics undersample the
  spectral envelope and LPC starts locking onto individual harmonics rather
  than formants. Sopranos and children will be noisier.
- Analysis runs on the main thread in `requestAnimationFrame`. Fine at this
  frame size; an `AudioWorklet` is the move if it ever competes with game
  rendering.

## Tests

```sh
npm test           # DSP + mapping, no browser needed
npm run test:e2e   # drives the real page in headless Chrome
```

`npm test` synthesizes vowels through a source-filter model (impulse train →
glottal shaping → resonators → lip radiation) and asserts the tracker recovers
the formants it was given, across F0 from 100–220 Hz and on both the native
11 kHz path and the 48 kHz decimation fallback. It also checks the mapping pins
the calibration corners exactly, puts Peterson–Barney vowels in the right
regions, and stays monotonic in both axes.

`npm run test:e2e` feeds Chrome a WAV of synthesized /i/, /ɑ/, /u/ as a fake
microphone, drives the page over the DevTools Protocol, and asserts the live
readouts track each vowel. Pass a path to save a screenshot. It skips cleanly
if no Chrome is installed.

## Layout

| file | role |
| --- | --- |
| `js/dsp.js` | LPC, root finding, pitch, filters — no DOM, no audio API |
| `js/tracker.js` | Mic graph and the per-frame analysis pipeline |
| `js/vowels.js` | Chart geometry, vowel inventory, formant→position mapping |
| `js/chart.js` | Canvas rendering: quadrilateral, cursor, trail, spectrum |
| `js/main.js` | UI wiring, calibration flow, animation loop |
| `test/` | Unit tests, plus the CDP browser harness and its audio fixture |
