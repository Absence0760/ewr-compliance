# EWR Compliance Measurement

Compares observed river flows with Environmental Water Requirements at the EWR nodes and
sites of the Berg, Breede-Overberg, Gouritz and Olifants-Doorn basins. It is a static web
app, and flow files loaded by a user stay in their browser. Its server parts are `server/`,
which decides who may open the hosted site (admins keep a list of users, and nobody else gets
in), and `pipeline/`, which keeps the site's own copy of DWS gauge flow current.

This repository is the code, with a synthetic sample dataset to run it on. The real EWR
data is not here: see [Data](#data).

## Run

Needs Node 24 and pnpm 10 (Corepack).

```
pnpm install && pnpm data:sample && pnpm dev
```

Then open http://localhost:7790. The nodes you see are invented.

To host it, run `pnpm build` and copy `build/` to any static host, at a domain root or under a sub-path. Hosting real data is a decision of its own: see `docs/hosting.md`. The site's own host, a private S3 bucket behind CloudFront in AWS af-south-1 (`infra/`), is deployed from a workstation with `tools/deploy.sh sample` or `tools/deploy.sh real`, and `--dry-run` to see what would go up. The steps to go live, and the checks after, are `docs/hosting.md` § Deploy readiness.

## Data

`static/data` is ignored by git, and is filled by one of two commands.

- **`pnpm data:sample`** copies the synthetic sample from `e2e/fixtures/sample-data`. It has a node of each kind the app treats differently, in every basin: a `.tab` node, Revised `.rul` nodes, a flow-only node, an Olifants-Doring node with Cumulative and Incremental runs, a site at a node, an approximate node and a node with no coordinates. Every code and number is invented by `e2e/fixtures/make-sample-data.mjs`, which is deterministic. To change the sample, change that script and rerun it. If `static/data` holds anything but the sample the command refuses, so real data is never lost silently. `pnpm data:sample --force` replaces it. Its `privacy.md`, the privacy notice the app shows at `privacy/`, is made up too.
- **`pnpm data:private`** needs access to the private repo `ewr-compliance-private`, cloned beside this one, or named by `EWR_PRIVATE_DIR`. It copies the real data to `static/data`, with the real privacy notice, and the tests pinned to it to `src/private` and `e2e/tests/private`. All of that is ignored by git.

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

## DWS data

The browser does not call DWS. DWS refuses networks outside South Africa, so a pipeline in AWS Cape Town pulls each linked gauge's flow from DWS every day into our own store, and the site serves the store under `dws/` (the private hosting plan, phase P4). Data source > DWS (kept current) reads it, in either comparison. Its files, and the pipeline that writes them (`pipeline/`), are described in `docs/architecture.md` § DWS store.

- It is offered at a node with a linked gauge, for that gauge's station, and applies the node's factor exactly as the gauge source does. The factor scales the node's observed flow, never the gauge's own record.
- The Real Time Comparison reads the station's daily flow and, where DWS has them, its 12-minute readings, drawn a month at a time as a linked gauge's are.
- The Historical Comparison reads the station's monthly volumes only when the store has them. Until it does, the source says so and cannot be picked, and the linked gauge's monthly record in `gauges.json` is what the comparison uses.
- Each comparison says when the store last fetched the station and the days it covers, and says so plainly when the pipeline has marked the station out of date.
- A copy of the site with no store, such as `pnpm dev`, `pnpm preview` or a plain static host, makes one request for `dws/index.json`, gets a 404, and the source says the store isn't there. Everything else works.

Flow can also be loaded by hand from a spreadsheet or text file: in each comparison's Data source, or in the Load flow data window in the compliance panel, which takes monthly flow for the Historical Comparison and 12-minute or daily flow for the Real Time Comparison. A node with no linked gauge starts there, on Spreadsheet.

An older version had a DWS API form, whose addresses it kept in the browser. They are dropped from the browser's storage the first time this version runs.
