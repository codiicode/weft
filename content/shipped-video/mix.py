#!/usr/bin/env python3
"""Shipped-since-launch video soundtrack: Cascade Breathe from its bar 1 (as in the launch, LP and
Papertrade videos), so the drop (track bar 9) lands where the list speeds up (film bar 8). A soft
tick as each item lands on the wall.
  python3 content/shipped-video/mix.py   -> out/weft-shipped.mp4 (from out/weft-shipped-silent.mp4)
"""
import os, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
FF = subprocess.check_output(["node", "-e", 'console.log(require("@ffmpeg-installer/ffmpeg").path)'], cwd=ROOT, text=True).strip()
MUSIC = os.path.join(ROOT, "content/music/nveravetyanmusic-cascade-breathe-future-garage-412839.mp3")
SFX = os.path.join(ROOT, "content/music/sfx")
VIDEO = os.path.join(HERE, "out/weft-shipped-silent.mp4")
OUT = os.path.join(HERE, "out/weft-shipped.mp4")
BAR = 240 / 130.01
def b(n):
    return 0.044 + n * BAR
DUR = b(14.4)
START = BAR
# when each item lands (same timing as the film)
LAND = [b(1.5) + i * 0.75 * BAR + 0.75 * BAR * 0.92 for i in range(8)] + [b(8) + j * 0.25 * BAR + 0.25 * BAR * 0.92 for j in range(8)]
END = b(12.4)

EVENTS = [
    ("whoosh1", 0.1, -32, None),
    *[("tick", t, -33 if i < 8 else -35, None) for i, t in enumerate(LAND)],
    ("whoosh4", b(1.5), -33, None),
    ("boom", b(8), -26, 3.0),
    ("shimmer", LAND[-1] + 0.05, -30, 2.2),
    ("whoosh5", b(12), -31, None),
    ("thread", END + 0.05, -28, None),
    ("boom", END + 0.9, -25, 3.3),
    ("shimmer", END + 0.95, -32, 2.4),
]

def main():
    inputs = ["-i", VIDEO, "-i", MUSIC]
    parts = [f"[1:a]atrim={START}:{START + DUR},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.4,afade=t=out:st={DUR - 2.8}:d=2.8[music]"]
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
    print(OUT, f"{DUR:.2f}s")

if __name__ == "__main__":
    main()
