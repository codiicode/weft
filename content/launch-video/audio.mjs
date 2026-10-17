// Synthesises the launch video's soundtrack, cued to the animation's timeline, as a 48 kHz stereo WAV.
//   node content/launch-video/audio.mjs   → out/weft-launch.wav
// A warm pad under everything, a soft pulse once the story gets going, and small sounds on the
// on-screen events: threads tying, typing, phrases lighting up, rules landing, the order filling.
import { writeFileSync, mkdirSync } from "node:fs";

const SR = 48_000;
const DUR = 73;
const N = SR * DUR;
const L = new Float32Array(N);
const R = new Float32Array(N);
const out = new URL("./out/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });

// Deterministic noise.
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);
const add = (i, l, r = l) => { if (i >= 0 && i < N) { L[i] += l; R[i] += r; } };

/* ---------------- instruments ---------------- */

/** Pad: a few detuned, softened saw voices per note, slow attack and release. */
function pad(t0, dur, notes, gain = 0.05) {
  const a = 1.6, rel = 2.2;
  const s0 = Math.floor(t0 * SR), s1 = Math.floor((t0 + dur + rel) * SR);
  const voices = notes.flatMap((m, k) => [-0.12, 0, 0.11].map((d) => ({ f: midi(m + d * 0.1), ph: Math.abs(rnd()), pan: (k / Math.max(1, notes.length - 1) - 0.5) * 0.8 + d })));
  let lpL = 0, lpR = 0;
  for (let i = s0; i < s1 && i < N; i++) {
    const t = (i - s0) / SR;
    const env = Math.min(1, t / a) * (t > dur ? Math.max(0, 1 - (t - dur) / rel) : 1);
    let l = 0, r = 0;
    for (const v of voices) {
      v.ph += v.f / SR;
      // a soft saw: a handful of harmonics
      const p = v.ph * 2 * Math.PI;
      const x = Math.sin(p) + Math.sin(2 * p) / 2.4 + Math.sin(3 * p) / 4.5 + Math.sin(4 * p) / 8;
      l += x * (0.5 - v.pan * 0.5); r += x * (0.5 + v.pan * 0.5);
    }
    // gentle low-pass, opening slowly
    const c = 0.06 + 0.04 * Math.sin(t * 0.4);
    lpL += c * (l - lpL); lpR += c * (r - lpR);
    add(i, lpL * env * gain / voices.length * 3, lpR * env * gain / voices.length * 3);
  }
}
/** Soft kick: a falling sine with a quick decay. */
function kick(t0, gain = 0.5) {
  const s0 = Math.floor(t0 * SR); let ph = 0;
  for (let j = 0; j < SR * 0.45; j++) { const t = j / SR; const f = 42 + 90 * Math.exp(-t * 28); ph += f / SR; add(s0 + j, Math.sin(ph * 2 * Math.PI) * Math.exp(-t * 9) * gain); }
}
/** Closed hat: a short high noise tick. */
function hat(t0, gain = 0.05, pan = 0.2) {
  const s0 = Math.floor(t0 * SR); let prev = 0;
  for (let j = 0; j < SR * 0.05; j++) { const n = rnd(); const hp = n - prev; prev = n; const e = Math.exp(-j / SR * 90) * gain; add(s0 + j, hp * e * (1 - pan), hp * e * (1 + pan)); }
}
/** Typing click. */
function click(t0, gain = 0.07) {
  const s0 = Math.floor(t0 * SR); let prev = 0; const pan = rnd() * 0.3;
  for (let j = 0; j < SR * 0.018; j++) { const n = rnd(); const hp = n - prev * 0.6; prev = n; const e = Math.exp(-j / SR * 400) * gain; add(s0 + j, hp * e * (1 - pan), hp * e * (1 + pan)); }
  let ph = 0; for (let j = 0; j < SR * 0.02; j++) { ph += 1800 / SR; add(s0 + j, Math.sin(ph * 6.283) * Math.exp(-j / SR * 300) * gain * 0.4); }
}
/** Pluck/blip: sine plus a little second harmonic. */
function pluck(t0, m, gain = 0.12, dec = 5, pan = 0) {
  const s0 = Math.floor(t0 * SR); const f = midi(m); let ph = 0;
  for (let j = 0; j < SR * 1.2; j++) { const t = j / SR; ph += f / SR; const x = Math.sin(ph * 6.283) + 0.3 * Math.sin(ph * 12.566) * Math.exp(-t * 12); const e = Math.min(1, t * 400) * Math.exp(-t * dec) * gain; add(s0 + j, x * e * (1 - pan), x * e * (1 + pan)); }
}
/** Chime: a bell-like stack. */
function chime(t0, m, gain = 0.12) {
  [[1, 1, 2.2], [2.01, 0.5, 3], [3.02, 0.3, 4.5], [4.2, 0.15, 6]].forEach(([r, g, d]) => {
    const s0 = Math.floor(t0 * SR); const f = midi(m) * r; let ph = 0;
    for (let j = 0; j < SR * 2.5; j++) { const t = j / SR; ph += f / SR; add(s0 + j, Math.sin(ph * 6.283) * Math.min(1, t * 600) * Math.exp(-t * d) * gain * g); }
  });
}
/** Whoosh: filtered noise swelling up and away. */
function whoosh(t0, dur, gain = 0.12, up = true) {
  const s0 = Math.floor(t0 * SR); let lp = 0, lp2 = 0;
  for (let j = 0; j < SR * dur; j++) {
    const t = j / dur / SR; const env = Math.sin(Math.PI * Math.pow(t, up ? 1.6 : 0.6));
    const c = 0.01 + 0.25 * (up ? t : 1 - t);
    lp += c * (rnd() - lp); lp2 += c * (lp - lp2);
    const pan = Math.sin(t * Math.PI * 1.5) * 0.6;
    add(s0 + j, (lp - lp2 * 0.5) * env * gain * (1 - pan), (lp - lp2 * 0.5) * env * gain * (1 + pan));
  }
}
/** Boom: a deep thump for big moments. */
function boom(t0, gain = 0.6) {
  const s0 = Math.floor(t0 * SR); let ph = 0;
  for (let j = 0; j < SR * 1.6; j++) { const t = j / SR; const f = 36 + 50 * Math.exp(-t * 8); ph += f / SR; add(s0 + j, Math.sin(ph * 6.283) * Math.exp(-t * 2.6) * gain); }
  whoosh(t0 - 0.02, 0.5, 0.06, false);
}

/* ---------------- score (seconds match video.html) ---------------- */
// Pad progression in A minor: Am9 → Fmaj7 → Cadd9 → G6, one chord every ~7.75 s.
const CHORDS = [[45, 57, 60, 64, 71], [41, 53, 57, 60, 64], [48, 55, 60, 62, 67], [43, 55, 59, 62, 64]];
for (let i = 0, t = 0; t < DUR - 4; i++, t += 7.75) pad(t, 7.75 + 1.2, CHORDS[i % 4], 0.055);

// The pulse: from the sentence to the safety scene, 104 BPM, building through the live part.
const BEAT = 60 / 104;
for (let t = 6.5; t < 67.0; t += BEAT) {
  const intensity = t < 15 ? 0.18 : t < 24.6 ? 0.28 : t < 33.2 ? 0.3 + 0.18 * ((t - 24.6) / 8.6) : 0.42;
  if (!(t > 32.6 && t < 33.7)) kick(t, intensity);
  hat(t + BEAT / 2, 0.035 + intensity * 0.04, 0.3);
  if (t > 24.6) hat(t + BEAT / 4, 0.015, -0.3), hat(t + (3 * BEAT) / 4, 0.015, -0.3);
}

// 0–3 s: five threads draw, the knot ties.
whoosh(0.05, 1.3, 0.1);
boom(1.12, 0.55);
chime(1.15, 76, 0.07); chime(1.15, 83, 0.04);
// Straight through the knot into the hook.
whoosh(2.85, 0.75, 0.09);
pluck(3.32, 69, 0.05, 4); pluck(4.55, 64, 0.05, 4);
// Live readings flicker on all around the line: tiny ticks, then they rush into the middle.
{ const r = (s) => () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296); const q = r(31);
  for (let i = 0; i < 44; i++) hat(4.55 + (i / 44) * 1.3 + q() * 0.25, 0.018, q() * 1.6 - 0.8); }
whoosh(5.75, 0.8, 0.09, false);
pluck(6.5, 64, 0.06, 4); pluck(6.52, 71, 0.04, 4);
// Typing the long sentence (7.1 → 11.9 s).
const PROMPT_LEN = "If @elonmusk posts about flying cars at today’s Tesla event while $TSLA mentions on X triple, Tesla headlines keep coming, TSLA is up 2% and funding stays low, long TSLA 10x with $200. Take profit at 40%, stop at 15%, and sell if the buzz halves.".length;
for (let i = 0; i < PROMPT_LEN; i++) if (i % 2 === 0 || rnd() > 0.45) click(7.1 + (i / PROMPT_LEN) * 4.8 + rnd() * 0.008, 0.05);
// Nine phrases light up, a rising run.
[69, 72, 74, 76, 79, 81, 84, 86, 88].forEach((m, i) => pluck(12.05 + i * 0.27, m, 0.085, 5, (i % 3 - 1) * 0.3));
// Send.
click(14.55, 0.12); whoosh(14.55, 1.0, 0.12);
// The nine phrases fly off the sentence and land as boxes, then the threads weave, the knot ties.
whoosh(14.7, 0.9, 0.07);
[64, 67, 69, 71, 74, 76, 79, 81, 83].forEach((m, i) => pluck(15.42 + i * 0.05, m, 0.06, 7, (i / 4 - 1) * 0.5));
whoosh(16.3, 1.2, 0.06);
pluck(17.35, 76, 0.1, 4); chime(17.37, 88, 0.03);
pluck(17.9, 81, 0.09, 5);
[79, 76, 72].forEach((m, i) => pluck(18.45 + i * 0.15, m, 0.06, 7, 0.3));
// Title swap, then it goes live: the clock speeds up, each condition turns true with a step up.
whoosh(24.0, 0.9, 0.05);
// green lines run round each box as it turns true (below), the camera creeps in
for (let t = 24.7; t < 33.1; ) { hat(t, 0.055, 0.5); t += 0.36 * Math.max(0.22, 1 - (t - 24.7) / 9.5); }
[[25.3, 64], [27.4, 67], [29.6, 71], [31.4, 74], [33.0, 76]].forEach(([t, m], i) => { pluck(t, m, 0.1 + i * 0.012, 4); chime(t + 0.02, m + 12, 0.025 + i * 0.006); });
// The knot fires.
boom(33.15, 0.8);
chime(33.15, 69, 0.1); chime(33.17, 76, 0.08); chime(33.19, 81, 0.06); chime(33.21, 88, 0.04);
chime(33.75, 93, 0.06);
[34.15, 34.4, 34.65].forEach((t, i) => pluck(t, [84, 81, 79][i], 0.05, 6, 0.4));
// Through the knot into the montage; the strip pans twice, then on to the threads.
whoosh(34.6, 0.85, 0.12);
[39.05, 42.55, 45.95].forEach((t) => whoosh(t, 0.75, 0.07));
[[35.3, 3], [39.4, 5], [42.9, 3]].forEach(([b, n]) => {
  for (let j = 0; j < n; j++) pluck(b + 0.15 + j * 0.1, 60 + j * 2, 0.04, 8, -0.3);
  whoosh(b + 0.6, 0.6, 0.04);
  for (let j = 0; j < n; j++) pluck(b + 1.9 + j * 0.14, 76 + j * 3, 0.07, 6, 0.2);
  const f = b + 1.9 + n * 0.14;
  kick(f, 0.4); chime(f, 81, 0.06); chime(f + 0.02, 88, 0.04);
});
// Every source is a thread.
const PENTA = [69, 72, 74, 76, 79, 81, 84, 86, 88, 91, 93, 96];
PENTA.forEach((m, i) => pluck(47.25 + i * 0.08, m - 12, 0.06, 7, (i % 4 - 1.5) * 0.3));
pluck(48.45, 69, 0.09, 4); chime(48.47, 81, 0.05);
PENTA.forEach((m, i) => pluck(49.2 + i * 0.13, m, 0.03, 3, (i % 4 - 1.5) * 0.4));
// A line of light wipes across into the copy scene.
whoosh(52.0, 0.8, 0.08);
// Copy: the click, the copy, the close.
click(54.45, 0.18); pluck(54.5, 79, 0.08, 6);
pluck(55.0, 76, 0.07, 5); pluck(55.7, 83, 0.08, 5);
chime(57.0, 81, 0.07);
// Another wipe, then the simple one.
whoosh(58.0, 0.8, 0.08);
for (let i = 0; i < 27; i++) click(58.9 + i * 0.037, 0.06);
[0, 1, 2, 3].forEach((i) => pluck(60.0 + i * 0.12, [72, 76, 79, 83][i], 0.05, 6, (i - 1.5) * 0.25));
whoosh(60.25, 0.7, 0.035);
[0, 1, 2, 3].forEach((i) => pluck(60.65 + i * 0.12, [79, 83, 86, 88][i], 0.055, 5, (i - 1.5) * 0.3));
for (let i = 0; i < 9; i++) click(61.1 + i * 0.07, 0.035 * (1 - i / 10));
kick(62.0, 0.3); chime(62.0, 88, 0.08); chime(62.02, 81, 0.06);
// The camera drops down to safety; orders land, a withdrawal hits the lock twice.
whoosh(62.85, 0.8, 0.08);
[64.5, 65.2, 65.9].forEach((t, i) => { click(t, 0.04); pluck(t + 0.48, [76, 79, 83][i], 0.05, 6, 0.4); });
[65.85, 66.95].forEach((t) => { kick(t, 0.28); click(t, 0.1); });
// Everything collapses into the knot.
whoosh(67.05, 0.7, 0.1, false);
// End: threads again, the knot, a long last chord.
whoosh(67.65, 1.3, 0.1);
boom(68.72, 0.7);
chime(68.75, 69, 0.08); chime(68.77, 76, 0.07); chime(68.79, 83, 0.05);
pad(68.6, 3.5, [45, 52, 57, 64, 71, 76], 0.06);

/* ---------------- space and master ---------------- */
// A small stereo reverb: a few feedback combs per side.
function reverb(x, combs, mix) {
  const y = new Float32Array(x.length);
  for (const [d, fb] of combs) { const D = Math.floor(d * SR); const buf = new Float32Array(D); let k = 0, lp = 0; for (let i = 0; i < x.length; i++) { const o = buf[k]; lp += 0.4 * (o - lp); buf[k] = x[i] + lp * fb; k = (k + 1) % D; y[i] += o / combs.length; } }
  for (let i = 0; i < x.length; i++) x[i] = x[i] * (1 - mix) + y[i] * mix * 2.2;
}
reverb(L, [[0.0297, 0.8], [0.0371, 0.79], [0.0411, 0.78], [0.0437, 0.77]], 0.22);
reverb(R, [[0.0313, 0.8], [0.0353, 0.79], [0.0423, 0.78], [0.0459, 0.77]], 0.22);

// Fade in/out and a soft limiter.
let peak = 0;
for (let i = 0; i < N; i++) {
  const t = i / SR; const f = Math.min(1, t / 0.05) * Math.min(1, (DUR - t) / 2.5);
  L[i] = Math.tanh(L[i] * 1.6) * f * 0.85; R[i] = Math.tanh(R[i] * 1.6) * f * 0.85;
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}

// 16-bit WAV.
const data = Buffer.alloc(N * 4);
for (let i = 0; i < N; i++) { data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), i * 4); data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), i * 4 + 2); }
const h = Buffer.alloc(44);
h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
writeFileSync(`${out}weft-launch.wav`, Buffer.concat([h, data]));
console.log(`wrote ${out}weft-launch.wav (peak ${peak.toFixed(2)})`);
