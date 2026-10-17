#!/usr/bin/env python3
"""Rewards video soundtrack: Cascade Breathe (130 BPM) from its first bar, the drop under the split,
with sound effects well under the music (-24 to -38 dB). The film is built on the track's own bar
grid (bar = 1.846 s, downbeat 0.044 s), so no re-timing.

  python3 content/rewards-video/mix.py   -> out/weft-rewards.mp4 (from out/weft-rewards-silent.mp4)
"""
import os, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
FF = subprocess.check_output(["node", "-e", 'console.log(require("@ffmpeg-installer/ffmpeg").path)'], cwd=ROOT, text=True).strip()
MUSIC = os.path.join(ROOT, "content/music/nveravetyanmusic-cascade-breathe-future-garage-412839.mp3")
SFX = os.path.join(ROOT, "content/music/sfx")
VIDEO = os.path.join(HERE, "out/weft-rewards-silent.mp4")
OUT = os.path.join(HERE, "out/weft-rewards.mp4")

BAR = 240 / 130.01
def b(n):
    return 0.044 + n * BAR
BEAT = BAR / 4
DUR = b(25.5)

# (sound, time, gain dB, trim to seconds or None)
EVENTS = [
    ("typing", b(3) + 0.35, -36, None),   # the sentence types itself
    ("click", b(4.5), -32, None),         # send
    ("chime", b(5), -28, None),           # order filled
    ("tick", b(5.5), -32, None),          # the fee chips off
    ("whoosh1", b(6) - 0.25, -30, None),  # into the fees
    ("thread", b(7.5), -30, None),        # half of it buys $WEFT
    ("riser", b(9) - 2.42, -30, None),    # up into the drop
    ("boom", b(9), -25, 3.0),             # the split
    ("whoosh4", b(10.5), -30, None),      # the burn
    ("whoosh5", b(11.5), -31, None),      # into today's pot
    ("tick", b(13), -34, None),           # the clock runs out
    ("tick", b(13) + BEAT, -34, None),
    ("tick", b(13) + 2 * BEAT, -34, None),
    ("chime", b(14), -27, None),          # midnight
    ("shimmer", b(14) + 0.05, -33, 2.0),
    ("click", b(16), -32, None),          # claim
    ("shimmer", b(16.25) + 0.1, -31, 2.2), # tokens fly to the wallet
    ("chime", b(16.25) + 1.0, -30, None),
    ("whoosh1", b(17.75), -31, None),     # tiers
    ("whoosh4", b(20.5), -31, None),      # the real numbers
    ("thread", b(23.5), -27, None),       # the end knot
    ("boom", b(23.5) + 0.9, -24, 4.0),
    ("shimmer", b(23.5) + 0.95, -31, 2.4),
]

def main():
    inputs = ["-i", VIDEO, "-i", MUSIC]
    parts = [f"[1:a]atrim=0:{DUR},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.6,afade=t=out:st={DUR - 3.2}:d=3.2[music]"]
    labels = []
    for i, (name, t, db, trim) in enumerate(EVENTS):
        inputs += ["-i", os.path.join(SFX, f"{name}.mp3")]
        delay = max(0, int(round(t * 1000)))
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
