#!/usr/bin/env python3
"""LP video soundtrack: Cascade Breathe from bar 3, so its drop (bar 9) lands on "Start
trading"; quiet UI sounds (-26 to -36 dB).
  python3 content/lp-video/mix.py   -> out/weft-lp.mp4 (from out/weft-lp-silent.mp4)
"""
import os, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
FF = subprocess.check_output(["node", "-e", 'console.log(require("@ffmpeg-installer/ffmpeg").path)'], cwd=ROOT, text=True).strip()
MUSIC = os.path.join(ROOT, "content/music/nveravetyanmusic-cascade-breathe-future-garage-412839.mp3")
SFX = os.path.join(ROOT, "content/music/sfx")
VIDEO = os.path.join(HERE, "out/weft-lp-silent.mp4")
OUT = os.path.join(HERE, "out/weft-lp.mp4")
BAR = 240 / 130.01
def b(n):
    return 0.044 + n * BAR
DUR = b(15.6)
START = 3 * BAR  # track bar 3 lines up with film bar 0

EVENTS = [
    ("whoosh1", b(2), -32, None),        # describe it
    ("typing", b(2) + 0.35, -36, 2.6),   # the prompt
    ("click", b(3) + 1.35, -31, None),   # send
    ("whoosh4", b(4), -32, None),        # the plan
    ("click", b(6) - 0.12, -30, None),   # Start trading
    ("boom", b(6), -26, 3.0),            # the drop
    ("chime", b(6) + 0.15, -30, None),   # deposited
    ("tick", b(9.2), -31, None),         # out of range
    ("chime", b(10.05), -29, None),      # withdrawn
    ("whoosh5", b(11), -31, None),       # pools
    ("thread", b(13), -28, None),        # the end knot
    ("boom", b(13) + 0.9, -25, 3.3),
    ("shimmer", b(13) + 0.95, -32, 2.4),
]

def main():
    inputs = ["-i", VIDEO, "-i", MUSIC]
    parts = [f"[1:a]atrim={START}:{START + DUR},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.8,afade=t=out:st={DUR - 2.8}:d=2.8[music]"]
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
