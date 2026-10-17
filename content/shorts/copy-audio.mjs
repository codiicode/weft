// Soundtrack for copy.html → out/copy.wav.
import { createMix } from "./synth.mjs";
const m = createMix(28.5);
const { pad, kick, hat, click, pluck, chime, whoosh, boom } = m;
const CHORDS = [[45, 57, 60, 64, 71], [41, 53, 57, 60, 64], [48, 55, 60, 62, 67], [43, 55, 59, 62, 64]];
for (let i = 0, t = 0; t < 24; i++, t += 7.75) pad(t, 7.75 + 1.2, CHORDS[i % 4], 0.05);
const BEAT = 60 / 104;
for (let t = 3.0; t < 24.1; t += BEAT) { kick(t, 0.16); hat(t + BEAT / 2, 0.035, 0.3); }
pluck(0.3, 69, 0.05, 4); pluck(0.42, 76, 0.04, 4);
whoosh(1.6, 1.2, 0.08);
click(5.55, 0.13); pluck(5.6, 76, 0.06, 5); whoosh(5.8, 0.6, 0.05);
for (let i = 0; i < 33; i++) click(7.35 + (i / 33) * 2.0 + m.rnd() * 0.006, 0.045);
click(9.65, 0.12); whoosh(9.65, 0.8, 0.06);
pluck(9.8, 72, 0.06, 5); pluck(11.6, 76, 0.06, 5);
chime(12.1, 81, 0.07); chime(12.12, 88, 0.04); pluck(12.1, 69, 0.08, 4);
whoosh(14.8, 0.7, 0.035);
whoosh(16.8, 0.8, 0.06);
[18.6, 19.0, 19.4, 19.8].forEach((t, i) => pluck(t, [76, 79, 83, 88][i], 0.055, 5, (i - 1.5) * 0.3));
chime(20.5, 81, 0.06);
whoosh(22.0, 0.8, 0.05);
whoosh(23.9, 0.9, 0.09, false);
whoosh(24.6, 1.2, 0.09);
boom(25.6, 0.6); chime(25.62, 69, 0.08); chime(25.64, 76, 0.07); chime(25.66, 83, 0.05);
pad(25.4, 3.0, [45, 52, 57, 64, 71, 76], 0.06);
m.write(new URL("./out/copy.wav", import.meta.url).pathname);
