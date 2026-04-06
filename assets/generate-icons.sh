#!/bin/bash
# Quick script to generate placeholder icons using ImageMagick (if installed).
# Run once: bash assets/generate-icons.sh
# Or replace with your own PNG icons manually.

for size in 16 48 128; do
  convert -size ${size}x${size} \
    -background "#141414" \
    -fill "#f5c518" \
    -gravity Center \
    -font Arial-Bold \
    -pointsize $((size / 2)) \
    label:"★" \
    "assets/icon${size}.png"
  echo "Generated icon${size}.png"
done
