//! voicesu's per-frame pipeline as WebAssembly: the voicing measure from
//! js/engines/lpc.js and the LPC formant analysis from js/dsp.js.
//!
//! A line-for-line port. The constants, loop order, Durand-Kerner seeds and
//! stopping rule match the JavaScript, so both back ends report the same
//! formants up to floating-point rounding in the math library.
//!
//! No allocation and no bindings: JavaScript writes a frame into the buffer
//! at `frame_ptr()`, calls `voicing` or `lpc_formants`, and reads the results
//! from the buffer at `out_ptr()`.

use core::f64::consts::PI;
use core::ptr::addr_of_mut;

const MAX_N: usize = 4096;
const MAX_ORDER: usize = 32;

// Layout of the output buffer, in f64 slots.
//   voicing():      0 rms, 1 f0, 2 clarity
//   lpc_formants(): 0 gain, A_AT.. the coefficients a[0..=order],
//                   F_AT.. (frequency, bandwidth) for each formant
const A_AT: usize = 8;
const F_AT: usize = A_AT + MAX_ORDER + 1;
const OUT_LEN: usize = F_AT + 2 * MAX_ORDER;

struct State {
    frame: [f64; MAX_N],
    work: [f64; MAX_N],
    window: [f64; MAX_N],
    window_n: usize,
    out: [f64; OUT_LEN],
}

static mut STATE: State = State {
    frame: [0.0; MAX_N],
    work: [0.0; MAX_N],
    window: [0.0; MAX_N],
    window_n: 0,
    out: [0.0; OUT_LEN],
};

fn state() -> &'static mut State {
    // Single-threaded: each WebAssembly instance has its own memory.
    unsafe { &mut *addr_of_mut!(STATE) }
}

#[no_mangle]
pub extern "C" fn frame_ptr() -> *mut f64 {
    state().frame.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn out_ptr() -> *const f64 {
    state().out.as_ptr()
}

#[no_mangle]
pub extern "C" fn max_frame() -> u32 {
    MAX_N as u32
}

#[no_mangle]
pub extern "C" fn a_at() -> u32 {
    A_AT as u32
}

#[no_mangle]
pub extern "C" fn f_at() -> u32 {
    F_AT as u32
}

#[no_mangle]
pub extern "C" fn out_len() -> u32 {
    OUT_LEN as u32
}

/// measureVoicing() without the gate: rms(), then detectPitch() over 70-400 Hz.
#[no_mangle]
pub extern "C" fn voicing(n: u32, sr: f64) {
    let s = state();
    let n = (n as usize).min(MAX_N);
    let x = &s.frame[..n];
    let mut sum = 0.0;
    for &v in x {
        sum += v * v;
    }
    s.out[0] = (sum / n as f64).sqrt();
    let (f0, clarity) = detect_pitch(x, sr, 70.0, 400.0);
    s.out[1] = f0;
    s.out[2] = clarity;
}

/// Normalized-autocorrelation pitch detector (detectPitch in js/dsp.js).
fn detect_pitch(x: &[f64], sr: f64, fmin: f64, fmax: f64) -> (f64, f64) {
    let n = x.len();
    let min_lag = (sr / fmax).floor() as usize;
    let max_lag = ((sr / fmin).floor() as usize).min(n.saturating_sub(1));
    if max_lag <= min_lag {
        return (0.0, 0.0);
    }

    let mut e0 = 0.0;
    for &v in x {
        e0 += v * v;
    }
    if e0 <= 0.0 {
        return (0.0, 0.0);
    }

    let mut best_lag: Option<usize> = None;
    let mut best_val = 0.0;
    for lag in min_lag..=max_lag {
        let mut num = 0.0;
        let mut den = 0.0;
        for i in lag..n {
            num += x[i] * x[i - lag];
            den += x[i - lag] * x[i - lag];
        }
        let norm = num / ((den * e0).sqrt() + 1e-12);
        if norm > best_val {
            best_val = norm;
            best_lag = Some(lag);
        }
    }
    match best_lag {
        Some(lag) => (sr / lag as f64, best_val.min(1.0).max(0.0)),
        None => (0.0, 0.0),
    }
}

/// LpcEngine.analyzeFrame: pre-emphasis, Hamming window, LPC, root finding,
/// and the resonance filter. Returns the number of formants, or -1 when the
/// frame is silent or the recursion fails (JavaScript's `model: null`).
#[no_mangle]
pub extern "C" fn lpc_formants(n: u32, sr: f64, order: u32, min_f: f64, max_f: f64, max_bw: f64) -> i32 {
    let s = state();
    let n = (n as usize).min(MAX_N);
    let order = (order as usize).min(MAX_ORDER);
    if n < 2 {
        return -1;
    }

    // hamming(n), cached per length
    if s.window_n != n {
        for i in 0..n {
            s.window[i] = 0.54 - 0.46 * ((2.0 * PI * i as f64) / (n as f64 - 1.0)).cos();
        }
        s.window_n = n;
    }

    // preEmphasis(frame), then the window
    let x = &s.frame[..n];
    let w = &mut s.work[..n];
    w[0] = x[0];
    for i in (1..n).rev() {
        w[i] = x[i] - 0.97 * x[i - 1];
    }
    for i in 0..n {
        w[i] *= s.window[i];
    }

    // autocorr(x, order)
    let mut r = [0.0f64; MAX_ORDER + 1];
    for k in 0..=order {
        let mut sum = 0.0;
        for i in k..n {
            sum += w[i] * w[i - k];
        }
        r[k] = sum;
    }

    // lpc(): Levinson-Durbin with the same white-noise correction
    if r[0] <= 0.0 {
        return -1;
    }
    r[0] *= 1.0001;
    r[0] += 1e-9;
    let mut a = [0.0f64; MAX_ORDER + 1];
    a[0] = 1.0;
    let mut err = r[0];
    for i in 1..=order {
        let mut acc = r[i];
        for j in 1..i {
            acc += a[j] * r[i - j];
        }
        let k = -acc / err;
        if !k.is_finite() {
            return -1;
        }
        let prev = a;
        for j in 1..i {
            a[j] = prev[j] + k * prev[i - j];
        }
        a[i] = k;
        err *= 1.0 - k * k;
        if err <= 0.0 {
            err = 1e-12;
            break;
        }
    }
    let gain = err.sqrt();

    // polyRoots(a): Durand-Kerner with spiral seeds, updated in place
    let mut re = [0.0f64; MAX_ORDER];
    let mut im = [0.0f64; MAX_ORDER];
    let (mut pr, mut pi) = (1.0f64, 0.0f64);
    let (cr, ci) = (0.4f64, 0.9f64);
    for i in 0..order {
        re[i] = pr;
        im[i] = pi;
        let nr = pr * cr - pi * ci;
        pi = pr * ci + pi * cr;
        pr = nr;
    }
    for _ in 0..120 {
        let mut max_step = 0.0f64;
        for i in 0..order {
            let (mut vr, mut vi) = (a[0], 0.0f64);
            for k in 1..=order {
                let t = vr * re[i] - vi * im[i] + a[k];
                vi = vr * im[i] + vi * re[i];
                vr = t;
            }
            let (mut dr, mut di) = (1.0f64, 0.0f64);
            for j in 0..order {
                if j == i {
                    continue;
                }
                let ar = re[i] - re[j];
                let ai = im[i] - im[j];
                let nr = dr * ar - di * ai;
                di = dr * ai + di * ar;
                dr = nr;
            }
            let den = dr * dr + di * di;
            if den < 1e-300 {
                continue;
            }
            let qr = (vr * dr + vi * di) / den;
            let qi = (vi * dr - vr * di) / den;
            re[i] -= qr;
            im[i] -= qi;
            let step = qr.abs() + qi.abs();
            if step > max_step {
                max_step = step;
            }
        }
        if max_step < 1e-13 {
            break;
        }
    }

    // formantsFromLpc(): one root per conjugate pair, stable, in band, narrow enough
    let mut freqs = [0.0f64; MAX_ORDER];
    let mut bws = [0.0f64; MAX_ORDER];
    let mut count = 0usize;
    for i in 0..order {
        if im[i] <= 0.0 {
            continue;
        }
        let mag = re[i].hypot(im[i]);
        if mag >= 1.0 || mag <= 0.0 {
            continue;
        }
        let freq = (im[i].atan2(re[i]) * sr) / (2.0 * PI);
        let bw = (-mag.ln() * sr) / PI;
        if freq < min_f || freq > max_f || bw > max_bw {
            continue;
        }
        freqs[count] = freq;
        bws[count] = bw;
        count += 1;
    }

    // Stable insertion sort by frequency, as Array.prototype.sort is stable
    for i in 1..count {
        let (f, b) = (freqs[i], bws[i]);
        let mut j = i;
        while j > 0 && freqs[j - 1] > f {
            freqs[j] = freqs[j - 1];
            bws[j] = bws[j - 1];
            j -= 1;
        }
        freqs[j] = f;
        bws[j] = b;
    }

    s.out[0] = gain;
    s.out[A_AT..A_AT + order + 1].copy_from_slice(&a[..order + 1]);
    for i in 0..count {
        s.out[F_AT + 2 * i] = freqs[i];
        s.out[F_AT + 2 * i + 1] = bws[i];
    }
    count as i32
}
