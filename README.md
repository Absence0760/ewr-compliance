# EWR Compliance Measurement

Compares observed river flows with Environmental Water Requirements at the EWR nodes and
sites of the Berg, Breede-Overberg, Gouritz and Olifants-Doorn basins. It is a static web
app: there is no server code, and flow files loaded by a user stay in their browser.

This repository is the code, with a synthetic sample dataset to run it on. The real EWR
data is not here: see [Data](#data).

## Run

Needs Node 24 and pnpm 10 (Corepack).

```
pnpm install && pnpm data:sample && pnpm dev
```

Then open http://localhost:7790. The nodes you see are invented.

To host it, run `pnpm build` and copy `build/` to any static host, at a domain root or under a sub-path. Hosting real data is a decision of its own: see `docs/hosting.md`.

## Data

`static/data` is ignored by git, and is filled by one of two commands.

- **`pnpm data:sample`** copies the synthetic sample from `e2e/fixtures/sample-data`. It has a node of each kind the app treats differently, in every basin: a `.tab` node, Revised `.rul` nodes, a flow-only node, an Olifants-Doring node with Cumulative and Incremental runs, a site at a node, an approximate node and a node with no coordinates. Every code and number is invented by `e2e/fixtures/make-sample-data.mjs`, which is deterministic. To change the sample, change that script and rerun it. If `static/data` holds anything but the sample the command refuses, so real data is never lost silently. `pnpm data:sample --force` replaces it.
- **`pnpm data:private`** needs access to the private repo `ewr-compliance-private`, cloned beside this one, or named by `EWR_PRIVATE_DIR`. It copies the real data to `static/data`, and the tests pinned to it to `src/private` and `e2e/tests/private`. All of that is ignored by git.

## Test

```
pnpm data:sample
pnpm check
pnpm test
pnpm test:e2e
```

Unit tests and the Playwright suite in `e2e/` run on the sample, and their expected numbers are hand arithmetic on it. The specs use a production build with synthetic flow files, the live boundaries and gauges stubbed, and no base map. `hosting.spec.ts` runs a second build for `/ewr/` on a plain static host. CI does the same.

With the private repo to hand, `pnpm test:private` copies it in and runs the suites pinned to the real data: the parsers over every supplied file, and the same behaviour as the specs here at real nodes. The public specs pin the sample, so they do not run on real data and will refuse to. `pnpm data:sample --force` goes back.

Those stubs say nothing about the real services, so check them by hand from time to time:

```
node tools/check-live-services.ts
```

It runs the app's own queries against the live ArcGIS layers and exits non-zero if a field, value, node quaternary or drainage region has gone, or a result comes back short. It needs network access, prints only counts, sizes and times, and writes nothing, because the polygons must stay out of this repository (`NOTICE.md`).

## Rebuild the data

The real data is generated, into the private repo. Rebuild it when source files or gazette tables change, with `P=../ewr-compliance-private`:

```
python $P/tools/build_data.py "<EWR Compliance folder>" <unzipped dir> $P/static/data $P/docs/data-review.csv <quaternaries.geojson> $P/docs/build-sources.json
```

`<unzipped dir>` holds `breede/EWR` and `gouritz/EWR`, the two supplied zips unpacked. `build-sources.json` names the supplied files. Needs `openpyxl python-docx xlrd shapely`, and `pdftotext`.

`data-review.csv` in the private repo lists every join and correction a person should check. Commit the rebuild there, then run `pnpm test:private` here.

Gauges have their own step, which needs nothing but the links and the gauge files:

```
python $P/tools/build_gauges.py $P/docs/gauge-links.csv $P/static/data <file> ...
```

Give it every monthly `.mon` file, in either format, every DWS `.day` file and every workbook of 12-minute readings each time, because what it writes replaces what was there. A workbook needs `openpyxl`. `gauge-links.csv` holds a row for each linked node: its gauge, the factor on the gauge record, and a note shown beside the factor. The factor is worked out outside the app, and 1 means none is applied.

What the RQO node workbook records at each node, shown in its map popup, has its own step too:

```
python $P/tools/build_node_info.py <RQO node workbook.xlsx> $P/static/data
```

It writes `node-info.json` from the workbook's sheet of all nodes: the REMP/BM site, the EWR site ID of the Reserve Gazette, the water quality monitoring station, and the surface water and groundwater Strategic Water Source Areas. It needs `openpyxl`, and the `index.json` already there, because a row whose node is not in it stops the build.

A node with no KML point is placed inside its quaternary. Once `index.json` holds a point for that quaternary, a rebuild keeps it, so re-simplified polygons do not move those nodes. Build into the private repo's `static/data`, or a copy of it, to keep them.

The rivers each WMA's map draws and names are public, and committed in `static/geo/rivers-<wma>.json`. Rebuild them with:

```
node tools/build-rivers.ts
```

It reads the DWS 1:500 000 rivers, the primary and secondary rivers with each reach's `NAME`, `STRAHLER` order and flow `CLASS`, from the `Rivers` layer of the DWS ArcGIS service. It puts each reach in every 2023 WMA whose outline it enters, so a river on a boundary is on both maps. It needs network access and takes about a minute.

`tools/build_geo.py` writes the quaternaries file that the private build places nodes with (needs mapshaper). Its source is the DWS service. The polygons must not be committed, because DWS supplies them without distribution rights. The app reads them and the WMA and basin outlines live in the browser. See `NOTICE.md`.

## Base map

Optional. Without it the map draws on a plain background.

`tools/fetch-tiles.sh` puts a Protomaps extract of South Africa, to zoom 13, and label fonts in `static/tiles/`, which git ignores, and writes `.env.local`. It needs the `pmtiles` CLI. To host, keep `static/tiles/` in the build, or set `VITE_TILES_URL` to any host that allows cross-origin range requests. See `.env.example` and `docs/hosting.md`.

## Docs

- `docs/architecture.md`: structure and conventions.
- `docs/hosting.md`: what to build, upload and set to host it.

The client brief is in the private repo.

## DWS API

DWS has not published the API, so its address, its parameters and its response format are unknown. The form under each comparison (Data source > DWS API) is ready for it, and what it accepts is an assumption until DWS publishes something. Expect to change it then.

The DWS API is each comparison's default source at a node with no linked gauge. The Historical Comparison makes one request, to the monthly volumes API. The Real Time Comparison makes two, each with its own address: the daily flow API, for the whole daily record, and the real-time API, for the latest readings. Either can be left blank. The two are drawn together a month at a time, as a linked gauge's daily flow and readings are, with a day in the daily record taken from it and not from the readings. Neither is scaled by a node's factor: like a file, the API gives the node's flow as it is.

Until then, and afterwards, flow can be loaded by hand from a spreadsheet or text file: in each comparison's Data source, or in the Load flow data window in the compliance panel, which takes monthly flow for the Historical Comparison and 12-minute or daily flow for the Real Time Comparison.

Enter the address with `{station}`, `{from}` and `{to}` where they belong; they are filled in as an ISO date and time. The endpoint must allow cross-origin requests from wherever this app is hosted, or be proxied, and a site on `https` can only call an `https` endpoint. The address and station are kept in the browser, separately for each comparison, so don't put a key in the address.

| | Monthly volumes API (Historical) | Daily flow API (Real Time) | Real-time API (Real Time) |
|---|---|---|---|
| Request window | The whole record: `{from}` is 1900-01-01, earlier than any series in the real data, and `{to}` is now | The whole record, as for monthly volumes | The last 31 days |
| Response | A date and a flow for each month, or a year with month columns | A date and a flow for each day, with an optional quality column | A time and a flow |
| Unit | Mm³ per month unless a column name gives the unit; change it under Values are in | m³/s, as for real time | m³/s. Data that declares Mm³, from a file or the API, is refused: a volume per reading has no defined interval to convert over |
| Timeout | 180 seconds | 180 seconds | 60 seconds |

The response may be JSON rows (a list, or a list under `data` or `rows`) or CSV. Either way it is read as a file would be. An `error` or `errors` field, an empty list, a web page, or a body that is neither gives a message saying so, and replaces any flow on show. A failed request (a network failure, a timeout or a 4xx or 5xx status) gives a message and leaves the flow on show, with its status line, until it is replaced.
