#!/usr/bin/env bash
# Puts the optional base map in static/tiles (git ignored) and writes .env.local.
#   tools/fetch-tiles.sh [source.pmtiles]
# The source defaults to yesterday's Protomaps world build. pmtiles reads only the byte
# ranges for this box, so it downloads the extract, not the planet. Needs the pmtiles CLI.
set -euo pipefail
cd "$(dirname "$0")/.."
# South Africa, Lesotho and Eswatini: every WMA. Zoom 13 is about 250 MB, half of zoom 14, and
# MapLibre stretches zoom 13 tiles to draw closer in.
BBOX='16.3,-35.0,33.0,-22.0'
MAXZOOM=13
ASSETS=028c18f713baecad011301ff7a69acc39bcc2ae7
source="${1:-https://build.protomaps.com/$(date -u -d yesterday +%Y%m%d).pmtiles}"
mkdir -p static/tiles
pmtiles extract "$source" static/tiles/south-africa.pmtiles --bbox="$BBOX" --maxzoom="$MAXZOOM"
# The Western Cape extract this replaced, on a machine that still has it.
rm -f static/tiles/western-cape.pmtiles
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "https://github.com/protomaps/basemaps-assets/archive/$ASSETS.tar.gz" | tar xz -C "$tmp"
rm -rf static/tiles/fonts
cp -r "$tmp/basemaps-assets-$ASSETS/fonts" static/tiles/fonts
cp .env.example .env.local
du -sh static/tiles
