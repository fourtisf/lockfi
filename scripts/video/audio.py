#!/usr/bin/env python3
"""The video's soundtrack, synthesised: nothing licensed, nothing sampled.

    python3 audio.py <out.wav> [click times...]

A slow pad in D major, an ocean wash under it, a soft arpeggio while the
steps play, quiet ticks on the cursor's clicks, swells at the scene changes
and a low bloom under the two titles. Peaks at -1 dBFS.
"""
import sys
import wave

import numpy as np

SR = 48_000
DUR = 66.0
N = int(SR * DUR)
t = np.arange(N) / SR
rng = np.random.default_rng(7)
out = sys.argv[1]
clicks = [float(x) for x in sys.argv[2:]] or [13.5, 15.0, 19.9, 22.5, 23.3, 28.9, 48.1, 51.3, 52.7, 53.7]

NOTE = {
    'G1': 49.0, 'A1': 55.0, 'B1': 61.74, 'D2': 73.42, 'G2': 98.0, 'A2': 110.0, 'B2': 123.47, 'C#3': 138.59,
    'D3': 146.83, 'E3': 164.81, 'F#3': 185.0, 'G3': 196.0, 'A3': 220.0, 'B3': 246.94, 'C#4': 277.18,
    'D4': 293.66, 'E4': 329.63, 'F#4': 369.99, 'G4': 392.0, 'A4': 440.0, 'B4': 493.88, 'C#5': 554.37,
    'D5': 587.33, 'E5': 659.26, 'F#5': 739.99, 'A5': 880.0,
}
CHORDS = [
    ('D2', ['D3', 'F#3', 'A3', 'C#4', 'E4'], ['A4', 'C#5', 'E5', 'F#5']),
    ('B1', ['B2', 'D3', 'F#3', 'A3', 'C#4'], ['F#4', 'A4', 'C#5', 'D5']),
    ('G1', ['G2', 'B2', 'D3', 'F#3', 'A3'], ['D5', 'B4', 'F#5', 'A4']),
    ('A1', ['A2', 'E3', 'A3', 'B3', 'C#4'], ['E5', 'C#5', 'B4', 'A4']),
]
SEG = DUR / 8


def env_seg(i):
    """Raised-cosine window for chord i, overlapping its neighbours by 2.4 s."""
    a, b = i * SEG, (i + 1) * SEG
    x = np.zeros(N)
    fade = 2.4
    up = np.clip((t - (a - fade / 2)) / fade, 0, 1)
    down = np.clip(((b + fade / 2) - t) / fade, 0, 1)
    x = np.minimum(up, down)
    return 0.5 - 0.5 * np.cos(np.pi * x)


def sine(f, phase=0.0):
    return np.sin(2 * np.pi * f * t + phase)


L = np.zeros(N)
R = np.zeros(N)

# Pad: each note as two detuned partials per side, slow breathing.
pad_l, pad_r = np.zeros(N), np.zeros(N)
for i in range(8):
    root, notes, _ = CHORDS[i % 4]
    e = env_seg(i)
    for j, n in enumerate(notes):
        f = NOTE[n]
        amp = 0.11 / (1 + 0.25 * j)
        breath = 0.82 + 0.18 * np.sin(2 * np.pi * (0.07 + 0.013 * j) * t + j)
        pad_l += e * amp * breath * (sine(f * 0.9988, j) + 0.35 * sine(f * 2.0012, 2 * j))
        pad_r += e * amp * breath * (sine(f * 1.0012, j + 1) + 0.35 * sine(f * 1.9988, 2 * j + 1))
    sub = e * 0.16 * sine(NOTE[root])
    pad_l += sub
    pad_r += sub
pad_gain = np.interp(t, [0, 2.5, 11.0, 12.5, 57.5, 59.0, 66], [0.0, 0.9, 0.9, 0.62, 0.62, 1.0, 1.0])
L += pad_l * pad_gain
R += pad_r * pad_gain

# Ocean: brown noise, gently swelling like waves.
def brown(n):
    w = rng.standard_normal(n)
    b = np.cumsum(w)
    k = int(SR * 0.05)
    trend = np.convolve(b, np.ones(k) / k, mode='same')
    return (b - trend) / 40


wash_gain = (0.55 + 0.45 * np.sin(2 * np.pi * t / 7.5 - 1.2)) * np.interp(t, [0, 1.5, 11, 12.5, 57.5, 59, 66], [0, 0.07, 0.07, 0.04, 0.04, 0.07, 0.07])
L += brown(N) * wash_gain
R += brown(N) * wash_gain

# Arpeggio: soft plucks on eighth notes at 100 bpm while the steps play.
step = 60 / 100 / 2
arp_l, arp_r = np.zeros(N), np.zeros(N)
k = 0
tt = 11.4
while tt < 58.2:
    i = int(tt // SEG)
    _, _, tones = CHORDS[i % 4]
    f = NOTE[tones[k % 4]] * (2 if k % 8 == 7 else 1)
    s0 = int(tt * SR)
    n = int(SR * 0.9)
    x = np.arange(n) / SR
    pl = (np.sin(2 * np.pi * f * x) + 0.3 * np.sin(4 * np.pi * f * x) * np.exp(-x * 9)) * np.exp(-x * 5.2) * np.minimum(1, x / 0.004)
    acc = 1.0 if k % 4 == 0 else 0.72
    pan = 0.5 + 0.28 * np.sin(k * 1.7)
    end = min(N, s0 + n)
    arp_l[s0:end] += pl[: end - s0] * acc * (1 - pan)
    arp_r[s0:end] += pl[: end - s0] * acc * pan
    k += 1
    tt += step
arp_gain = np.interp(t, [11.0, 13.0, 56.5, 58.4], [0, 0.085, 0.085, 0])
L += arp_l * arp_gain
R += arp_r * arp_gain

# Ticks on the cursor's clicks.
for c in clicks:
    s0 = int(c * SR)
    n = int(SR * 0.06)
    x = np.arange(n) / SR
    tick = (0.6 * np.sin(2 * np.pi * 2300 * x) * np.exp(-x * 140) + 0.4 * rng.standard_normal(n) * np.exp(-x * 400)) * 0.16
    L[s0:s0 + n] += tick
    R[s0:s0 + n] += tick

# Swells into each scene change, and a low bloom under the titles.
def swell(at, rise=0.9, fall=0.5, gain=0.12):
    a, b = int((at - rise) * SR), int((at + fall) * SR)
    n = b - a
    x = np.linspace(0, 1, n)
    e = np.where(x < rise / (rise + fall), (x / (rise / (rise + fall))) ** 2, np.exp(-(x - rise / (rise + fall)) * 9))
    noise = rng.standard_normal(n)
    smooth = np.convolve(noise, np.ones(24) / 24, mode='same')
    return a, b, smooth * e * gain


for at in (6.1, 11.3, 58.6):
    a, b, s = swell(at)
    L[a:b] += s
    R[a:b] += s[::-1] if len(s) else s


def bloom(at, gain=0.34):
    s0 = int(at * SR)
    n = int(SR * 2.6)
    x = np.arange(n) / SR
    f = 62 * np.exp(-x * 0.6) + 36
    ph = 2 * np.pi * np.cumsum(f) / SR
    return s0, (np.sin(ph) * np.exp(-x * 1.6) * np.minimum(1, x / 0.01) + 0.25 * np.sin(2 * ph) * np.exp(-x * 3)) * gain


for at in (2.25, 59.4):
    s0, b = bloom(at)
    end = min(N, s0 + len(b))
    L[s0:end] += b[: end - s0]
    R[s0:end] += b[: end - s0]

# Room: a short decaying-noise reverb, convolved in the frequency domain.
ir_n = int(SR * 2.4)
ir_t = np.arange(ir_n) / SR
ir = rng.standard_normal(ir_n) * np.exp(-ir_t * 2.6)
ir[: int(SR * 0.012)] = 0
ir /= np.sqrt(np.sum(ir ** 2))


def reverb(x):
    m = 1 << int(np.ceil(np.log2(len(x) + ir_n)))
    y = np.fft.irfft(np.fft.rfft(x, m) * np.fft.rfft(ir, m), m)[: len(x)]
    return y


L = L + 0.32 * reverb(L)
R = R + 0.32 * reverb(R)

# Master: fades, then peak at -1 dBFS.
master = np.interp(t, [0, 0.8, 64.6, 66], [0, 1, 1, 0])
L *= master
R *= master
peak = max(np.abs(L).max(), np.abs(R).max())
g = 10 ** (-1 / 20) / peak
L *= g
R *= g
rms = np.sqrt(np.mean((L ** 2 + R ** 2) / 2))
print(f'peak -1.0 dBFS, rms {20 * np.log10(rms):.1f} dBFS')
pcm = (np.stack([L, R], axis=1) * 32767).astype(np.int16)
with wave.open(out, 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print('wrote', out)
