// Soundtrack for tour.html → out/tour.wav. Cues match the clip times in tour.html.
import { createMix } from "./synth.mjs";
const m = createMix(42);
const { pad, kick, hat, click, pluck, chime, whoosh, boom } = m;

const CHORDS = [[45, 57, 60, 64, 71], [41, 53, 57, 60, 64], [48, 55, 60, 62, 67], [43, 55, 59, 62, 64]];
for (let i = 0, t = 0; t < 37; i++, t += 7.75) pad(t, 7.75 + 1.2, CHORDS[i % 4], 0.05);
const BEAT = 60 / 104;
for (let t = 3.0; t < 37.3; t += BEAT) { kick(t, 0.16); hat(t + BEAT / 2, 0.035, 0.3); }

pluck(0.3, 69, 0.05, 4); pluck(0.42, 76, 0.04, 4);
whoosh(1.6, 1.2, 0.08);
click(3.35, 0.12);
const N = 90; for (let i = 0; i < N; i++) if (i % 2 === 0 || m.rnd() > 0.3) click(3.45 + (i / N) * 3.7 + m.rnd() * 0.006, 0.045);
click(7.5, 0.12); whoosh(7.5, 0.8, 0.07);
pluck(7.8, 72, 0.06, 5); pluck(9.0, 76, 0.06, 5); pluck(9.23, 79, 0.06, 5);
chime(10.05, 81, 0.07); chime(10.07, 88, 0.04); pluck(10.05, 69, 0.08, 4);
whoosh(11.2, 0.8, 0.04); whoosh(13.8, 0.7, 0.035);
click(17.25, 0.12);
[76, 79, 83, 88].forEach((n, i) => pluck(17.75 + i * 0.07, n, 0.06, 6, (i - 1.5) * 0.3));
whoosh(20.8, 0.7, 0.035);
click(23.4, 0.14); kick(24.2, 0.35); chime(24.2, 76, 0.08); chime(24.22, 83, 0.06); chime(24.24, 88, 0.04);
whoosh(26.2, 0.8, 0.06); whoosh(29.2, 0.6, 0.03);
[31.9, 32.8, 33.7].forEach((t, i) => { click(t, 0.1); pluck(t + 0.03, [72, 76, 79][i], 0.05, 6, 0.3); });
whoosh(34.4, 0.8, 0.06);
whoosh(37.2, 0.9, 0.09, false);
whoosh(37.9, 1.2, 0.09);
boom(38.9, 0.6); chime(38.92, 69, 0.08); chime(38.94, 76, 0.07); chime(38.96, 83, 0.05);
pad(38.7, 3.0, [45, 52, 57, 64, 71, 76], 0.06);
m.write(new URL("./out/tour.wav", import.meta.url).pathname);
