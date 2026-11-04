#!/usr/bin/env python3
"""Original soundtrack and sound effects, synthesized from scratch with numpy.

No samples or third-party audio. Cue times match the `T` table in promo.js.
usage: audio.py out.wav
"""
import sys, wave
import numpy as np

SR = 44100
DUR = 36.0
N = int(SR * DUR)
rng = np.random.default_rng(7)
T = dict(s2=2.6, s4=7.2, s5=16.4, s6=21.4, s7=25.2, s8=28.4, s9=31.2)


def empty():
    return np.zeros((N, 2))


def add(bus, at, sig, gain=1.0, pan=0.0):
    i = int(at * SR)
    if i >= N or i < 0:
        return
    sig = sig[: N - i]
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    bus[i : i + len(sig), 0] += sig * gain * l
    bus[i : i + len(sig), 1] += sig * gain * r


def lowpass(x, fc, slope=2.0):
    f = np.fft.rfftfreq(len(x), 1 / SR)
    return np.fft.irfft(np.fft.rfft(x) / np.sqrt(1 + (f / fc) ** (2 * slope)), len(x))


def highpass(x, fc):
    return x - lowpass(x, fc)


def hz(note):
    return 440.0 * 2 ** ((note - 69) / 12)


def pad_note(f, dur, bright=1.0):
    t = np.arange(int(dur * SR)) / SR
    out = np.zeros_like(t)
    for det in (-0.0016, 0.0, 0.0019):
        for h, a in ((1, 1.0), (2, 0.42 * bright), (3, 0.2 * bright), (4, 0.09 * bright)):
            out += a * np.sin(2 * np.pi * f * h * (1 + det) * t + rng.uniform(0, 6.28))
    env = np.minimum(t / 0.75, 1) * np.minimum((dur - t) / 0.9, 1).clip(0, 1)
    return out * env ** 1.4 / 5


def pluck(f, dur=0.7):
    t = np.arange(int(dur * SR)) / SR
    return (np.sin(2 * np.pi * f * t) + 0.32 * np.sin(4 * np.pi * f * t) * np.exp(-t * 16) + 0.1 * np.sin(6 * np.pi * f * t) * np.exp(-t * 26)) * np.exp(-t * 6.4) * np.minimum(t / 0.002, 1)


def kick():
    t = np.arange(int(0.26 * SR)) / SR
    return np.sin(2 * np.pi * (48 * t + 9 * (1 - np.exp(-t * 34)))) * np.exp(-t * 15) * np.minimum(t / 0.001, 1)


def hat(dur=0.05):
    n = int(dur * SR)
    return highpass(rng.normal(size=n), 7000) * np.exp(-np.arange(n) / n * 7)


def sub(f, dur):
    t = np.arange(int(dur * SR)) / SR
    return np.sin(2 * np.pi * f * t) * np.minimum(t / 0.012, 1) * np.minimum((dur - t) / 0.12, 1).clip(0, 1)


def bell(f, dur=2.0):
    t = np.arange(int(dur * SR)) / SR
    return (np.sin(2 * np.pi * f * t) + 0.5 * np.sin(2 * np.pi * f * 2.01 * t) * np.exp(-t * 4) + 0.22 * np.sin(2 * np.pi * f * 3.02 * t) * np.exp(-t * 7)) * np.exp(-t * 3.1)


def whoosh(dur=0.95):
    n = int(dur * SR)
    t = np.linspace(0, 1, n)
    noise = rng.normal(size=n)
    lo, hi = lowpass(noise, 500), lowpass(noise, 3000)
    env = np.sin(np.pi * t ** 0.72) ** 2
    return (lo * (1 - t) + hi * t * 0.55) * env


def click():
    n = int(0.03 * SR)
    t = np.arange(n) / SR
    return (np.sin(2 * np.pi * 1900 * t) * 0.5 + highpass(rng.normal(size=n), 2500) * 0.4) * np.exp(-t * 340)


def reverb(x, tail=2.4, wet=0.26):
    n = int(tail * SR)
    t = np.arange(n) / SR
    out = np.zeros_like(x)
    for ch, seed in ((0, 1), (1, 2)):
        ir = np.random.default_rng(seed).normal(size=n) * np.exp(-t * 3.1)
        ir = lowpass(ir, 4800)
        ir /= np.sqrt(np.sum(ir ** 2))
        size = len(x) + n
        y = np.fft.irfft(np.fft.rfft(x[:, ch], size) * np.fft.rfft(ir, size), size)[: len(x)]
        out[:, ch] = x[:, ch] + y * wet
    return out


# D major loop: Dmaj9 · Bm7 · Gmaj7 · A6/9
CHORDS = [
    (38, [62, 69, 73, 76, 78]),
    (35, [59, 66, 69, 74, 78]),
    (31, [55, 62, 66, 71, 74]),
    (33, [57, 64, 69, 71, 73]),
]
MASTER = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0  # set so the mix measures about -16 LUFS
BEAT = 0.6
BAR = BEAT * 4
ORIGIN = T['s4'] - 3 * BAR  # bars start at 0 and the groove lands on s4

music, pads, drums, sfx = empty(), empty(), empty(), empty()

bar = 0
while ORIGIN + bar * BAR < T['s8']:
    at = ORIGIN + bar * BAR
    root, notes = CHORDS[bar % 4]
    full = at >= T['s4'] - 0.01
    for n in notes:
        add(pads, at, pad_note(hz(n), BAR + 0.9, 1.0 if full else 0.45), 0.2 if full else 0.075, pan=rng.uniform(-.5, .5))
    # Arpeggio: sparse in the dark, sixteenth-note drive once the title lands.
    pattern = [0, 2, 4, 3, 1, 4, 2, 3] if full else [0, -1, -1, 2, -1, -1, 4, -1]
    for k, idx in enumerate(pattern):
        if idx < 0:
            continue
        note = notes[idx] + 12
        when = at + k * BEAT / 2
        add(music, when, pluck(hz(note)), 0.15 if full else 0.13, pan=-.45 if k % 2 else .45)
        add(music, when + BEAT * .75, pluck(hz(note)), 0.05, pan=.45 if k % 2 else -.45)
    if full:
        add(music, at, sub(hz(root), BEAT * 1.6), 0.34)
        add(music, at + BEAT * 2.5, sub(hz(root), BEAT * 1.2), 0.28)
        for b in range(4):
            add(drums, at + b * BEAT, kick(), 0.5 if b % 2 == 0 else 0.3)
        if at >= T['s4'] + BAR:
            for b in range(8):
                add(drums, at + b * BEAT / 2, hat(), 0.05 if b % 2 else 0.09, pan=.22)
    bar += 1

# Opening note, then the lock screen; the task finishes.
add(sfx, .05, bell(hz(86), 1.4), 0.13)
add(sfx, T['s2'] + .08, bell(hz(69)), 0.14, pan=-.1)
add(sfx, T['s2'] + .2, bell(hz(76)), 0.1, pan=.1)
add(sfx, T['s2'] + 3.42, bell(hz(81)), 0.17, pan=.15)
add(sfx, T['s2'] + 3.58, bell(hz(88)), 0.13, pan=.25)

# Wave transitions.
for key in ('s4', 's5', 's6', 's7', 's8', 's9'):
    add(sfx, T[key] - .1, whoosh(), 0.13, pan=rng.uniform(-.25, .25))

# Touches in the app.
for at, gain in ((T['s4'] + 1.3, .24), (T['s4'] + 2.3, .24), (T['s4'] + 6.85, .3)):
    add(sfx, at, click(), gain)
add(sfx, T['s4'] + .05, kick(), 0.4)
add(sfx, T['s4'] + 5.1, bell(hz(83), 1.0), 0.12, pan=.2)

# Terminal: real keystrokes reach the screen around here.
for k in range(14):
    add(sfx, T['s5'] + 1.1 + k * 0.076, click(), 0.12, pan=-.2)
add(sfx, T['s5'] + 2.1, bell(hz(81), 1.0), 0.13)

# Island expands.
add(sfx, T['s7'] + 1.65, bell(hz(79), 1.2), 0.14, pan=-.2)

# Three beats, hard stop.
for i, note in enumerate((38, 35, 31)):
    at = T['s8'] + .55 + i * .68
    add(drums, at, kick(), 0.8)
    for n in (note + 24, note + 31, note + 36):
        add(pads, at, pad_note(hz(n), .62, 1.0), 0.42)

# Final chord resolves on the end card and rings out.
for n in (38, 50, 62, 69, 73, 76, 81):
    add(pads, T['s9'] + .35, pad_note(hz(n), 5.4, 0.8), 0.24, pan=rng.uniform(-.4, .4))
for k, n in enumerate((74, 78, 81, 85, 88)):
    add(music, T['s9'] + .4 + k * .13, pluck(hz(n + 12), 1.5), 0.13, pan=(-1) ** k * .35)
add(sfx, T['s9'] + .42, bell(hz(86), 2.4), 0.16)

# Pads stay out of the bass and kick's range, and out of the way of the plucks.
for c in range(2):
    pads[:, c] = lowpass(highpass(pads[:, c], 170), 3200)
mix = reverb(music + pads, wet=.3) + reverb(sfx, wet=.2) + drums
# Gentle master: low cut, soft saturation, loudness set by a final ffmpeg-checked peak.
for c in range(2):
    mix[:, c] = highpass(mix[:, c], 28)
fade = np.ones(N)
fade[-int(1.1 * SR):] = np.linspace(1, 0, int(1.1 * SR)) ** 1.5
mix = (mix.T * fade).T
mix = np.tanh(mix * MASTER)

with wave.open(sys.argv[1], 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((mix * 32767).astype('<i2').tobytes())
print('wrote', sys.argv[1], round(DUR, 1), 's')
