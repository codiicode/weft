#!/bin/bash
# Splices Goldn on bar lines (see README) and muxes it under the rendered film.
set -e
cd "$(dirname "$0")/../.."
FF=$(node -e 'console.log(require("@ffmpeg-installer/ffmpeg").path)')
M=content/music/kontraa-goldn-uk-drill-music-116392.mp3
"$FF" -y -loglevel error -i content/vision/out/weft-vision-silent.mp4 -i $M -i $M -filter_complex \
  "[1]atrim=0:18.112,asetpts=PTS-STARTPTS,afade=t=out:st=18.07:d=0.04[a];[2]atrim=42.77:66.6,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.03[b];[a][b]concat=n=2:v=0:a=1,atrim=0:41.9,afade=t=in:st=0:d=0.4,afade=t=out:st=39.2:d=2.7,loudnorm=I=-14:TP=-1.5:LRA=11[o]" \
  -map 0:v -map "[o]" -c:v libx264 -preset slow -crf 17 -maxrate 24M -bufsize 48M -pix_fmt yuv420p -c:a aac -b:a 256k -ar 48000 -movflags +faststart -shortest content/vision/out/weft-vision.mp4
echo content/vision/out/weft-vision.mp4
