// Soundtrack for sources.html → out/sources.wav.
import { createMix } from "./synth.mjs";
const m = createMix(25.5);
const { pad, kick, hat, click, pluck, chime, whoosh, boom } = m;
const CHORDS = [[45, 57, 60, 64, 71], [41, 53, 57, 60, 64], [48, 55, 60, 62, 67], [43, 55, 59, 62, 64]];
for (let i = 0, t = 0; t < 21; i++, t += 7.75) pad(t, 7.75 + 1.2, CHORDS[i % 4], 0.05);
const BEAT = 1.55 / 4;
for (let t = 2.3; t < 14.6; t += BEAT) { kick(t, (Math.round((t - 2.3) / BEAT) % 4 === 0) ? 0.3 : 0.12); hat(t + BEAT / 2, 0.035, 0.3); }
for (let t = 14.7; t < 21.0; t += 60 / 104) { kick(t, 0.18); hat(t + 30 / 104, 0.035, 0.3); }
pluck(0.3, 69, 0.05, 4); pluck(0.42, 76, 0.04, 4);
const NOTES = [69, 72, 74, 76, 79, 81, 84, 86];
NOTES.forEach((n, i) => {
  const a = 2.3 + i * 1.55;
  whoosh(a - 0.25, 0.5, 0.05);
  pluck(a + 0.02, n, 0.07, 5, (i % 2 ? 0.3 : -0.3));
  chime(a + 0.02 + 1.0, n + 12, 0.03);
});
whoosh(14.5, 0.9, 0.07);
[0, 1, 2, 3, 4, 5, 6, 7].forEach((i) => pluck(14.85 + i * 0.06, 60 + i * 2, 0.04, 8, -0.3));
whoosh(15.1, 1.6, 0.06);
boom(16.35, 0.6); chime(16.37, 69, 0.08); chime(16.39, 76, 0.07); chime(16.41, 83, 0.05);
for (let i = 0; i < 62; i++) click(17.3 + (i / 62) * 1.6 + m.rnd() * 0.006, 0.045);
chime(19.1, 79, 0.06); chime(19.14, 86, 0.05);
whoosh(20.9, 0.9, 0.08, false);
whoosh(21.6, 1.2, 0.09);
boom(22.55, 0.6); chime(22.57, 69, 0.08); chime(22.59, 76, 0.07); chime(22.61, 83, 0.05);
pad(22.4, 3.0, [45, 52, 57, 64, 71, 76], 0.06);
m.write(new URL("./out/sources.wav", import.meta.url).pathname);
