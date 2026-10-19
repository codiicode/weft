#!/usr/bin/env python3
"""How Weft works soundtrack: Cascade Breathe from its bar 1 (as in the other films), so its drop lands
on film bar 8, where Weft starts watching. Typing under the sentence, ticks as the rules land, a boom on
the drop, a chime when the order fills, a tick per example, the thread and boom on the end card.
  python3 content/howto-video/mix.py   -> out/weft-how-it-works.mp4 (from out/weft-how-silent.mp4)
"""
import os, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
FF = subprocess.check_output(["node", "-e", 'console.log(require("@ffmpeg-installer/ffmpeg").path)'], cwd=ROOT, text=True).strip()
MUSIC = os.path.join(ROOT, "content/music/nveravetyanmusic-cascade-breathe-future-garage-412839.mp3")
SFX = os.path.join(ROOT, "content/music/sfx")
VIDEO = os.path.join(HERE, "out/weft-how-silent.mp4")
OUT = os.path.join(HERE, "out/weft-how-it-works.mp4")
BAR = 240 / 130.01
def b(n):
    return 0.044 + n * BAR
DUR = b(32.4)
START = BAR
CH = dict(ch1=b(2), ch2=b(5), ch3=b(8), ch4=b(12), ch5=b(15), ch6=b(25), end=b(29.2))
FIRE = CH["ch3"] + BAR * 2.75
CARD0 = CH["ch5"] + BAR
STEP = (CH["ch6"] - CARD0) / 10

EVENTS = [
    ("whoosh1", 0.1, -32, None),
    ("thread", 0.2, -30, None),
    ("typing", CH["ch1"] + 0.6, -31, CH["ch2"] - 0.6 - (CH["ch1"] + 0.6)),
    ("whoosh4", CH["ch2"], -33, None),
    *[("tick", CH["ch2"] + 0.5 + i * 0.3 + j * 0.18, -34, None) for i in range(3) for j in range(2)],
    ("riser", b(7), -34, BAR * 1.0),
    ("boom", CH["ch3"], -26, 3.0),
    ("chime", FIRE, -29, None),
    ("shimmer", FIRE + 0.05, -31, 2.0),
    ("whoosh5", CH["ch4"], -32, None),
    ("click", CH["ch4"] + BAR * 1.3 + 0.55, -28, None),
    ("click", CH["ch4"] + BAR * 2.0 + 0.55, -28, None),
    ("whoosh4", CH["ch5"], -31, None),
    *[("tick", CARD0 + i * STEP + 0.05, -32, None) for i in range(10)],
    ("whoosh5", CH["ch6"], -32, None),
    ("thread", CH["end"] + 0.05, -28, None),
    ("boom", CH["end"] + 0.9, -25, 3.3),
    ("shimmer", CH["end"] + 0.95, -32, 2.4),
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
