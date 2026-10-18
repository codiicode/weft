#!/usr/bin/env python3
"""Papertrade video soundtrack: "Goldn" from 0:00 (146 BPM), so the bass lands on the cut to dark
(bar 4) and the full beat on Start (bar 8); quiet UI sounds (-25 to -36 dB).
  python3 content/papertrade-video/mix.py   -> out/weft-papertrade.mp4 (from out/weft-papertrade-silent.mp4)
"""
import json, os, re, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
FF = subprocess.check_output(["node", "-e", 'console.log(require("@ffmpeg-installer/ffmpeg").path)'], cwd=ROOT, text=True).strip()
MUSIC = os.path.join(ROOT, "content/music/kontraa-goldn-uk-drill-music-116392.mp3")
SFX = os.path.join(ROOT, "content/music/sfx")
VIDEO = os.path.join(HERE, "out/weft-papertrade-silent.mp4")
OUT = os.path.join(HERE, "out/weft-papertrade.mp4")
BAR = 240 / 146
BEAT = BAR / 4
def b(n):
    return 0.03 + n * BAR
DUR = b(19.75)
W2 = b(16.5)
END = W2 + 0.3

# when the trade gets in: where the entry candle crosses the level (same path as the film)
D = json.loads(re.search(r"window.PT_DATA = (.*);", open(os.path.join(HERE, "data.js")).read()).group(1))
k = D["candles"][D["entryIdx"]]
pts = [k["o"], k["l"], k["h"], k["c"]] if k["c"] >= k["o"] else [k["o"], k["h"], k["l"], k["c"]]
fe = 1.0
for i in range(501):
    s = i / 500 * 3
    j = min(2, int(s))
    if pts[j] + (pts[j + 1] - pts[j]) * (s - j) >= D["level"]:
        fe = i / 500
        break
ENTRY = b(10) + fe * BAR

EVENTS = [
    ("typing", 0.3, -34, 0.95),           # papertrade_ types itself
    ("whoosh1", b(1.5), -32, None),       # weft joins
    ("thread", b(1.5) + 0.1, -31, None),
    ("whoosh4", b(2.5) - 0.1, -33, None), # BTC and ETH
    ("tick", b(3.75), -30, None),         # 1000x
    ("boom", b(4), -27, 2.6),             # bass in, paper → dark
    ("whoosh5", b(4) - 0.05, -31, None),
    ("typing", b(4) + 0.6, -36, 2.5),     # the prompt
    ("click", b(5) + 1.3, -31, None),     # send
    ("whoosh4", b(6), -32, None),         # the plan
    ("click", b(8) - 0.12, -30, None),    # Start
    ("boom", b(8), -26, 3.0),             # the full beat
    *[("tick", b(8) + 0.25 + i * BEAT + BEAT * 0.8, -33, None) for i in range(3)],
    ("chime", b(8) + 0.25 + 3 * BEAT + 0.1, -31, None),  # watching BTC
    ("whoosh5", b(9.5), -31, None),       # the chart
    ("tick", ENTRY, -28, None),           # in on the break
    ("chime", b(13), -27, None),          # target hit
    ("shimmer", b(13) + 0.05, -31, 2.0),
    ("whoosh1", b(14.5), -32, None),      # facts
    ("whoosh5", W2, -31, None),           # back to paper
    ("thread", END + 0.05, -28, None),    # the threads
    ("boom", END + 0.9, -25, 3.3),        # the knot
    ("shimmer", END + 0.95, -32, 2.4),
]

def main():
    inputs = ["-i", VIDEO, "-i", MUSIC]
    parts = [f"[1:a]atrim=0:{DUR},asetpts=PTS-STARTPTS,afade=t=out:st={DUR - 2.8}:d=2.8[music]"]
    labels = []
    for i, (name, t, db, trim) in enumerate(EVENTS):
        inputs += ["-i", os.path.join(SFX, f"{name}.mp3")]
        delay = int(round(t * 1000))
        tr = f"atrim=0:{trim},afade=t=out:st={max(0.0, trim - 0.4)}:d=0.4," if trim else ""
        parts.append(f"[{2 + i}:a]{tr}aformat=channel_layouts=stereo,volume={db}dB,adelay={delay}|{delay}[s{i}]")
        labels.append(f"[s{i}]")
    parts.append(f"{''.join(labels)}amix=inputs={len(labels)}:normalize=0:dropout_transition=0,highpass=f=60,lowpass=f=12000[fx]")
    parts.append("[music][fx]amix=inputs=2:normalize=0:dropout_transition=0,loudnorm=I=-14:TP=-1.5:LRA=11[a]")
    cmd = [FF, "-y", "-loglevel", "error", *inputs, "-filter_complex", ";".join(parts), "-map", "0:v", "-map", "[a]",
           "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-maxrate", "24M", "-bufsize", "48M", "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-movflags", "+faststart", "-shortest", OUT]
    subprocess.run(cmd, check=True)
    print(OUT, f"{DUR:.2f}s", f"entry at {ENTRY:.2f}s")

if __name__ == "__main__":
    main()
