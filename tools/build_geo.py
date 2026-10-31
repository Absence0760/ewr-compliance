#!/usr/bin/env python3
"""Build static/data/map.json (rivers) and a private catchment file for the private repo's build_data.py.

The catchment output must stay out of git: DWS supplies it without distribution rights,
so the app reads those boundaries live from the DWS service instead.

Inputs (see README for download URLs):
  q4.geojson       DWS quaternaries tagged with basin (properties q, b)
  riv/wriall500    DWS 1:500k rivers shapefile (Cape datum)
Usage: build_geo.py <geo_dir> <mapshaper_bin> <output_json>
"""
import json, subprocess, sys, os
import shapefile
from pyproj import Transformer
from shapely.geometry import shape, LineString, mapping
from shapely.ops import unary_union, transform
from shapely.prepared import prep

geo, ms, out = sys.argv[1:4]
# 1. Simplify with shared topology so neighbouring catchments still meet.
subprocess.run([ms, f'{geo}/q4.geojson', '-simplify', 'visvalingam', 'weighted', 'interval=60', 'keep-shapes',
                '-clean', '-o', f'{geo}/q4s.geojson', 'format=geojson', 'precision=0.0001', 'force'], check=True)
subprocess.run([ms, f'{geo}/q4s.geojson', '-dissolve', 'fields=b', '-o', f'{geo}/b4.geojson', 'format=geojson',
                'precision=0.0001', 'force'], check=True)
quat = json.load(open(f'{geo}/q4s.geojson'))
basins = json.load(open(f'{geo}/b4.geojson'))

# 2. Rivers: clip to the study basins, shift Cape datum to WGS84, drop headwater reaches.
hi = unary_union([shape(f['geometry']) for f in json.load(open(f'{geo}/q4.geojson'))['features']]).buffer(0.01)
phi = prep(hi)
tx = Transformer.from_crs('EPSG:4222', 'EPSG:4326', always_xy=True)
sf = shapefile.Reader(f'{geo}/riv/wriall500')
names = [f.name for f in sf.fields[1:]]
ni, si = names.index('NAME'), names.index('STRAHLER')
feats = []
for sr in sf.iterShapeRecords():
    if not sr.shape.points: continue
    ln = LineString(sr.shape.points)
    if not phi.intersects(ln): continue
    strahler = sr.record[si] or 1
    if strahler < 2: continue
    ln = transform(lambda x, y: tx.transform(x, y), ln).simplify(0.0012)
    feats.append({'type': 'Feature', 'properties': {'n': (sr.record[ni] or '').strip(), 's': strahler},
                  'geometry': {'type': 'LineString', 'coordinates': [[round(x, 4), round(y, 4)] for x, y in ln.coords]}})
json.dump({'rivers': {'type': 'FeatureCollection', 'features': feats}}, open(out, 'w'), separators=(',', ':'))
json.dump(quat, open(f'{geo}/quaternaries-private.geojson', 'w'), separators=(',', ':'))
print(len(quat['features']), len(basins['features']), len(feats), os.path.getsize(out))
