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

`static/data` is ignored by git, all but `map.json`, and is filled by one of two commands.

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

A node with no KML point is placed inside its quaternary. Once `index.json` holds a point for that quaternary, a rebuild keeps it, so re-simplified polygons do not move those nodes. Build into the private repo's `static/data`, or a copy of it, to keep them.

`tools/build_geo.py` rebuilds `static/data/map.json`, which holds rivers only (also needs `pyshp pyproj`, and mapshaper):

- Rivers: DWS 1:500 000 `southafricanrivers_wriall500.zip`, from the WRC Water Resources Observatory.
- Quaternaries: the DWS service, used here only to place nodes. The polygons must not be committed, because DWS supplies them without distribution rights. The app reads them and the basin outlines live in the browser. See `NOTICE.md`.

## Base map

Optional. Without it the map draws on a plain background.

`tools/fetch-tiles.sh` puts a Western Cape Protomaps extract and label fonts in `static/tiles/`, which git ignores, and writes `.env.local`. It needs the `pmtiles` CLI. To host, keep `static/tiles/` in the build, or set `VITE_TILES_URL` to any host that allows cross-origin range requests. See `.env.example` and `docs/hosting.md`.

## Docs

- `docs/architecture.md`: structure and conventions.
- `docs/hosting.md`: what to build, upload and set to host it.

The client brief is in the private repo.

## DWS API

DWS has not published the API, so its address, its parameters and its response format are unknown. The form under each comparison (Data source > API) is ready for it, and what it accepts is an assumption until DWS publishes something. Expect to change it then.

Enter the address with `{station}`, `{from}` and `{to}` where they belong; they are filled in as an ISO date and time. The endpoint must allow cross-origin requests from wherever this app is hosted, or be proxied, and a site on `https` can only call an `https` endpoint. The address and station are kept in the browser, separately for each comparison, so don't put a key in the address.

| | Historical Comparison | Real Time Comparison |
|---|---|---|
| Request window | The whole record: `{from}` is 1900-01-01, earlier than any series in the real data, and `{to}` is now | The last 31 days |
| Response | A date and a flow for each month, or a year with month columns | A time and a flow |
| Unit | Mm³ per month unless a column name gives the unit; change it under Values are in | m³/s. Data that declares Mm³, from a file or the API, is refused: a volume per reading has no defined interval to convert over |
| Timeout | 180 seconds | 60 seconds |

The response may be JSON rows (a list, or a list under `data` or `rows`) or CSV. Either way it is read as a file would be. An `error` or `errors` field, an empty list, a web page, or a body that is neither gives a message saying so, and replaces any flow on show. A failed request (a network failure, a timeout or a 4xx or 5xx status) gives a message and leaves the flow on show, with its status line, until it is replaced.
