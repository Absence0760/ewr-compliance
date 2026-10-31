#!/usr/bin/env bash
# Puts the optional base map in static/tiles (git ignored) and writes .env.local.
#   tools/fetch-tiles.sh [source.pmtiles]
# The source defaults to yesterday's Protomaps world build. pmtiles reads only the byte
# ranges for this box, so it downloads the extract, not the planet. Needs the pmtiles CLI.
set -euo pipefail
cd "$(dirname "$0")/.."
BBOX='16.3,-35.0,25.7,-29.5'
MAXZOOM=14
ASSETS=028c18f713baecad011301ff7a69acc39bcc2ae7
source="${1:-https://build.protomaps.com/$(date -u -d yesterday +%Y%m%d).pmtiles}"
mkdir -p static/tiles
pmtiles extract "$source" static/tiles/western-cape.pmtiles --bbox="$BBOX" --maxzoom="$MAXZOOM"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "https://github.com/protomaps/basemaps-assets/archive/$ASSETS.tar.gz" | tar xz -C "$tmp"
cp -r "$tmp/basemaps-assets-$ASSETS/fonts" static/tiles/fonts
cp .env.example .env.local
du -sh static/tiles
