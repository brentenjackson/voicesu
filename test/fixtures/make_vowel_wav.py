"""Synthesize a WAV of three sustained vowels to feed Chrome as a fake mic."""
import math, struct, wave

SR = 48000
F0 = 120.0
SEG = 3.0  # seconds per vowel

# Male reference formants, matching PRESETS.male corners.
VOWELS = [
    ("i", [(280, 60), (2250, 90), (2900, 120), (3600, 200)]),
    ("a", [(730, 60), (1090, 90), (2440, 120), (3600, 200)]),
    ("u", [(310, 60), (870, 90), (2250, 120), (3600, 200)]),
]


def synth(formants, n):
    # Glottal impulse train
    x = [0.0] * n
    period = int(round(SR / F0))
    for i in range(0, n, period):
        x[i] = 1.0
    # Glottal shaping: two coincident real poles near DC (-12 dB/oct)
    g = math.exp(-2 * math.pi * 100 / SR)
    for _ in range(2):
        prev = 0.0
        for i in range(n):
            prev = x[i] + g * prev
            x[i] = prev
    # Vocal tract resonators
    for f, bw in formants:
        r = math.exp(-math.pi * bw / SR)
        theta = 2 * math.pi * f / SR
        a1, a2 = -2 * r * math.cos(theta), r * r
        gain = 1 + a1 + a2
        y1 = y2 = 0.0
        for i in range(n):
            y = gain * x[i] - a1 * y1 - a2 * y2
            y2, y1 = y1, y
            x[i] = y
    # Lip radiation: first difference
    out = [0.0] * n
    for i in range(1, n):
        out[i] = x[i] - x[i - 1]
    return out


frames = []
for name, formants in VOWELS:
    n = int(SR * SEG)
    sig = synth(formants, n)
    peak = max(abs(v) for v in sig) or 1.0
    # Short fades so segment boundaries don't click.
    fade = int(SR * 0.02)
    for i, v in enumerate(sig):
        amp = v / peak * 0.6
        if i < fade:
            amp *= i / fade
        elif i > n - fade:
            amp *= (n - i) / fade
        frames.append(max(-32767, min(32767, int(amp * 32767))))
    print(f"{name}: {n} samples")

import sys
path = sys.argv[1]
with wave.open(path, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(struct.pack(f"<{len(frames)}h", *frames))
print("wrote", path, len(frames) / SR, "s")
