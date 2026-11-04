#!/usr/bin/env python3
"""Build the private catchment file that the private repo's build_data.py places nodes with.

Its output must stay out of git: DWS supplies the quaternaries without distribution rights,
so the app reads those boundaries live from the DWS service instead. The rivers the map draws
are built by tools/build-rivers.ts.

Input (see README for the source):
  q4.geojson       DWS quaternaries tagged with basin (properties q, b)
Usage: build_geo.py <geo_dir> <mapshaper_bin>
"""
import json, subprocess, sys

geo, ms = sys.argv[1:3]
# Simplify with shared topology so neighbouring catchments still meet.
subprocess.run([ms, f'{geo}/q4.geojson', '-simplify', 'visvalingam', 'weighted', 'interval=60', 'keep-shapes',
                '-clean', '-o', f'{geo}/q4s.geojson', 'format=geojson', 'precision=0.0001', 'force'], check=True)
quat = json.load(open(f'{geo}/q4s.geojson'))
json.dump(quat, open(f'{geo}/quaternaries-private.geojson', 'w'), separators=(',', ':'))
print(len(quat['features']))
