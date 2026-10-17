#!/usr/bin/env python3
"""First-trade video soundtrack: Cascade Breathe from bar 41 (where it comes back up after the
breakdown), with quiet UI sounds on the clicks, the deposit and the start (-26 to -38 dB).

  python3 content/shorts/first-mix.py   -> out/first/weft-first-trade.mp4 (from out/first/first-silent.mp4)
"""
import os, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
FF = subprocess.check_output(["node", "-e", 'console.log(require("@ffmpeg-installer/ffmpeg").path)'], cwd=ROOT, text=True).strip()
MUSIC = os.path.join(ROOT, "content/music/nveravetyanmusic-cascade-breathe-future-garage-412839.mp3")
SFX = os.path.join(ROOT, "content/music/sfx")
VIDEO = os.path.join(HERE, "out/first/first-silent.mp4")
OUT = os.path.join(HERE, "out/first/weft-first-trade.mp4")
DUR = 43.0
START = 0.044 + 41 * 240 / 130.01  # track bar 41

# (sound, time, gain dB, trim to seconds or None)
EVENTS = [
    ("whoosh1", 2.25, -32, None),   # sign-in card
    ("click", 3.7, -32, None),      # continue with email
    ("shimmer", 4.35, -33, 1.8),    # the wallets appear
    ("whoosh4", 7.0, -32, None),    # add money
    ("chime", 8.4, -30, None),      # USDC arrived
    ("tick", 9.4, -33, None),       # moved to Hyperliquid
    ("whoosh5", 12.0, -30, None),   # the app rises
    ("click", 13.4, -34, None),     # the input
    ("typing", 13.65, -36, None),   # typing
    ("typing", 15.6, -36, 1.9),
    ("click", 17.95, -32, None),    # send
    ("thread", 18.5, -32, None),    # drafting
    ("click", 27.9, -30, None),     # start trading
    ("chime", 29.45, -28, None),    # running
    ("whoosh1", 34.4, -33, None),   # portfolio
    ("thread", 38.7, -28, None),    # end knot
    ("boom", 39.65, -25, 3.3),
    ("shimmer", 39.7, -32, 2.4),
]

def main():
    inputs = ["-i", VIDEO, "-i", MUSIC]
    parts = [f"[1:a]atrim={START}:{START + DUR},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=1.2,afade=t=out:st={DUR - 3.0}:d=3.0[music]"]
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
