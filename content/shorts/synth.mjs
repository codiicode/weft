// The launch video's synthesiser as a module, so every short shares its sound.
//   const m = createMix(42); m.pluck(1.2, 76); …; m.write("out/x.wav");
import { writeFileSync } from "node:fs";

export function createMix(DUR) {
const SR = 48_000;
const N = SR * DUR;
const L = new Float32Array(N);
const R = new Float32Array(N);
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);
const add = (i, l, r = l) => { if (i >= 0 && i < N) { L[i] += l; R[i] += r; } };

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


function write(path) {
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
  writeFileSync(path, Buffer.concat([h, data]));
  console.log(`wrote ${path} (peak ${peak.toFixed(2)})`);
  
}
return { pad, kick, hat, click, pluck, chime, whoosh, boom, write, rnd };
}
