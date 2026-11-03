// Per-engine calibration: storage keys, the pre-engines key, and corner capture.
import { storageKey, loadCalibration, saveCalibration, CornerCapture, MIN_FRAMES } from '../js/calibration.js';
import { PRESETS, CORNERS } from '../js/vowels.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Just enough of localStorage. */
const fakeStorage = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), map: m };
};

console.log('Storage:');
check(storageKey('lpc') === 'voicesu.calibration.v1', 'LPC keeps the original key');
check(storageKey('mfcc') === 'voicesu.calibration.v1.mfcc', 'other engines get their own key');

// A calibration saved before engines existed is LPC's.
const legacy = fakeStorage({ 'voicesu.calibration.v1': JSON.stringify(PRESETS.female) });
check(same(loadCalibration('lpc', legacy), PRESETS.female), 'existing calibration loads as LPC\'s');
check(same(loadCalibration('mfcc', legacy), PRESETS.male), 'an engine never calibrated starts on the male preset');

const store = fakeStorage();
saveCalibration('mfcc', PRESETS.child, store);
check(same(loadCalibration('mfcc', store), PRESETS.child) && same(loadCalibration('lpc', store), PRESETS.male),
  'saving one engine leaves the others alone');

const junk = fakeStorage({
  'voicesu.calibration.v1': '{not json',
  'voicesu.calibration.v1.mfcc': JSON.stringify({ closeFront: [300, 2200] }),
});
check(same(loadCalibration('lpc', junk), PRESETS.male) && same(loadCalibration('mfcc', junk), PRESETS.male),
  'corrupt or partial entries fall back to the preset');

console.log('\nCorner capture:');
const corner = CORNERS[0];
const cap = new CornerCapture(corner, ['lpc', 'mfcc'], 0);
const frame = (voiced, lpc, mfcc) => ({ voiced, results: { lpc, mfcc } });
const est = (f1, f2, updated = true) => ({ f1, f2, f3: 0, confidence: 1, updated });

for (let i = 0; i < 20; i++) {
  cap.push(frame(true, est(270 + i, 2240 + i), i % 4 === 0 ? est(480 + i, 1450) : est(999, 999, false)));
}
cap.push(frame(false, est(5000, 5000), est(5000, 5000))); // unvoiced: ignored
cap.push(frame(true, est(0, 0), undefined));              // no estimate yet: ignored
const med = cap.medians();
check(cap.frames === 21, `counts voiced frames (${cap.frames})`);
check(same(med.lpc, [280, 2250]), `LPC median of its own frames: ${med.lpc}`);
check(med.mfcc === null, `MFCC had ${20 / 4} fresh estimates (< ${MIN_FRAMES}): no corner from it`);

const cap2 = new CornerCapture(corner, ['mfcc'], 0);
for (let i = 0; i < MIN_FRAMES; i++) cap2.push(frame(true, est(280, 2250), est(500 + i, 1500)));
const med2 = cap2.medians();
check(same(med2, { mfcc: [504, 1500] }), 'only engines that were on at the start are recorded');

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
