#!/usr/bin/env python3
"""Launch video v5 soundtrack: Cascade Breathe (future garage, 130 BPM) cut on bars, with quiet sound effects.

The film is built on a 146 BPM grid; v5 plays it at 130/146 speed (render.mjs --warp 0.044,0.03,0.890486), so
every cut lands on the new track's beat. Bars of the film map one to one onto bars of the track:
  output bars 0-24  <- track bars 0-24   (intro, the drop on bar 9)
  output bars 24-32 <- track bars 33-41  (the track's breakdown under the film's quiet middle)
  output bars 32-   <- track bars 41-    (back up with the film)
Sound effects sit well under the music (-24 to -36 dB): texture, never the lead.

  python3 content/launch-video/mix-v5.py   -> out/weft-launch-v5.mp4 (from out/weft-launch-v5-silent.mp4)
"""
import os, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
FF = subprocess.check_output(["node", "-e", 'console.log(require("@ffmpeg-installer/ffmpeg").path)'], cwd=ROOT, text=True).strip()
MUSIC = os.path.join(ROOT, "content/music/nveravetyanmusic-cascade-breathe-future-garage-412839.mp3")
SFX = os.path.join(ROOT, "content/music/sfx")
VIDEO = os.path.join(HERE, "out/weft-launch-v5-silent.mp4")
OUT = os.path.join(HERE, "out/weft-launch-v5.mp4")

BAR = 4 * 60 / 130.01   # track bar, s
B0 = 0.044              # track downbeat
SCALE = 0.890486        # film seconds per output second
def o(v):               # film time -> output time
    return B0 + (v - 0.03) / SCALE
def bar(n):
    return B0 + n * BAR

DUR = o(78.6)

# (sound, film time, gain dB, trim to seconds or None)
EVENTS = [
    ("thread", 0.05, -26, None),     # the threads draw in
    ("boom", 1.10, -24, 3.5),        # the knot ties
    ("shimmer", 1.15, -32, 2.4),
    ("whoosh1", 2.90, -27, None),    # zoom through the knot
    ("whoosh4", 5.85, -28, None),    # the noise collapses
    ("typing", 7.10, -36, None),     # the prompt types itself
    ("typing", 9.25, -36, None),
    ("typing", 11.0, -37, 1.0),
    ("click", 12.05, -36, None),     # phrases light up
    ("click", 12.59, -36, None),
    ("click", 13.13, -36, None),
    ("click", 14.55, -30, None),     # send
    ("whoosh5", 14.62, -28, None),   # the phrases fly into the graph
    ("tick", 25.30, -32, None),      # conditions met, one by one
    ("tick", 27.40, -32, None),
    ("tick", 29.60, -32, None),
    ("tick", 31.40, -32, None),
    ("tick", 32.78, -31, None),
    ("boom", 32.91, -26, 3.0),       # all met: the order fires
    ("chime", 33.10, -27, None),     # order filled
    ("whoosh1", 39.30, -31, None),   # montage
    ("whoosh4", 42.80, -31, None),
    ("whoosh5", 45.95, -28, None),   # into the wall of sources
    ("whoosh1", 52.05, -28, None),   # wipe into copy trading
    ("whoosh4", 57.95, -28, None),   # wipe into the portfolio
    ("whoosh5", 63.65, -28, None),   # wipe into the simple trade
    ("whoosh1", 68.55, -30, None),   # up to safety
    ("riser", 70.70, -28, None),     # into the end
    ("boom", 74.00, -23, 4.5),       # the end knot ties
    ("shimmer", 74.05, -31, 2.4),
]

def main():
    inputs = ["-i", VIDEO, "-i", MUSIC, "-i", MUSIC, "-i", MUSIC]
    parts = []
    # music, cut on bars
    a0, a1 = 0.0, bar(24)
    b0, b1 = bar(33), bar(41)
    c0 = bar(41)
    c1 = c0 + (DUR - bar(32)) + 0.5
    parts.append(f"[1:a]atrim={a0}:{a1},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=1.2,afade=t=out:st={a1 - a0 - 0.03}:d=0.03[m1]")
    parts.append(f"[2:a]atrim={b0}:{b1},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.03,afade=t=out:st={b1 - b0 - 0.03}:d=0.03[m2]")
    parts.append(f"[3:a]atrim={c0}:{c1},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.03[m3]")
    parts.append(f"[m1][m2][m3]concat=n=3:v=0:a=1,atrim=0:{DUR},afade=t=out:st={DUR - 4.2}:d=4.2[music]")
    # sound effects
    labels = []
    for i, (name, v, db, trim) in enumerate(EVENTS):
        inputs += ["-i", os.path.join(SFX, f"{name}.mp3")]
        idx = 4 + i
        delay = max(0, int(round(o(v) * 1000)))
        t = f"atrim=0:{trim},afade=t=out:st={max(0.0, trim - 0.4)}:d=0.4," if trim else ""
        parts.append(f"[{idx}:a]{t}aformat=channel_layouts=stereo,volume={db}dB,adelay={delay}|{delay}[s{i}]")
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
