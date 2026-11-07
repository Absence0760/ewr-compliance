# Architecture

A static SvelteKit 3 app (`adapter-static`, `ssr = false`) with Svelte 5 runes and TypeScript.
Flow files stay in the browser, and everything else is static JSON in `static/data`. The one server
part is `functions/`, which decides who may open the site: § Users and access.

## Data tiers

`static/data` is not in this repo. It holds one of two datasets, with the same schema:

| | Synthetic sample | Real data |
|---|---|---|
| Source | `e2e/fixtures/sample-data`, written by `e2e/fixtures/make-sample-data.mjs` | The private repo `ewr-compliance-private`, built by its `tools/build_data.py` |
| Into `static/data` | `pnpm data:sample` | `pnpm data:private` |
| Tests | `pnpm test`, `pnpm test:e2e`, and CI | `pnpm test:private`, on a machine with the private repo |

The specs in `e2e/tests` pin the sample's numbers and the private ones pin real numbers, so each dataset runs its own specs. `index.json` in the sample carries `sample: true`, and the Playwright config uses it to refuse the wrong pairing. `pnpm data:private` copies the private tests to `src/private` and `e2e/tests/private`, both ignored by git. Copied tests import with `#lib/...` and `#e2e/...`, because a relative import would not survive the copy. `console-clean.spec.ts` pins no data and runs in both tiers.

The sample is small on purpose, and has one node of each kind the UI treats differently: `src/lib/ewr/sampleData.test.ts` keeps it that way, and `dataScripts.test.ts` covers the scripts that fill `static/data`, including that the committed sample is what its generator writes.

## Water Management Areas

The app opens on South Africa's six Water Management Areas of 2023 (`/`): a banner, a national map and the same WMAs as links, each with its number of EWR nodes. The national map names each WMA once its outlines load, at a fixed point inside it (`label` in `WMAS`), and Lesotho and Eswatini in grey (`NEIGHBOURS`), and marks the one hovered or focused in the list. The banner holds the page's title, its only h1, so the app bar leaves its own out on this page and shows it everywhere else. The list is the keyboard route, and the way in when the live WMA layer fails. Each WMA has its own page, `wma/<slug>/`, prerendered for the six slugs in `WMAS` (`src/lib/components/map/wma.ts`). Any other slug is a 404.

- A node is on the map of its basin's WMA, by `BASIN_WMA`. All four study basins are in Breede-Olifants. A basin missing from it is on no map, which `sampleData.test.ts` and `tools/check-live-services.ts` catch.
- A WMA's catchments and flow gauges are asked for by its box and kept by its outline, from the live `WMA_2023` layer: a catchment when most of its vertices are inside, so a neighbour sharing an edge is left out, and a gauge when it is inside. A quaternary a node of the WMA names is kept wherever it lies. If the outline fails, the box is all there is, and the map says it lost the outline.
- A WMA with no EWR data opens anyway, on its catchments, rivers and gauges, and says it has none.
- Rivers are `static/geo/rivers-<slug>.json`, the DWS 1:500 000 rivers built by `tools/build-rivers.ts`, with name `n`, Strahler order `s` and flow class `c`. Orders 1 and 2 are drawn from zoom 9. Hovering names a river, clicking opens its popup, and from zoom 10 names run along the line when the base map's fonts are there.

## Node information

`static/data/node-info.json` holds, by node id, what the RQO node workbook records at a node beyond its EWR: `remp`, the REMP/BM site, `ewrSite`, the EWR site ID of the Reserve Gazette, `wqStation`, the water quality monitoring station, and `swsaSw` and `swsaGw`, the surface water and groundwater Strategic Water Source Areas the node is in. Each value is the workbook's text, and a field it records nothing for is absent, as is a node it records nothing at. The node's map popup lists what there is, in that order (`infoRows`). It loads with `index.json`, and the app does not start without it. It is built in the private repo by `tools/build_node_info.py`: README § Rebuild the data.

## Loading flow by hand

Observed flow comes from a linked gauge, the DWS API once it exists, or a file. Each comparison's Data source lists these as radio buttons, each saying what it holds (`FlowImport.svelte`). A node with no linked gauge starts on the DWS API. The API's data is kept apart from a loaded file's (`histApiSlot`, `rtApiSlots`), so switching source shows each one's own. The Real Time Comparison's two API requests, daily flow and real-time readings, are put together by `gaugeSeries`, as a gauge's are (`apiRt`), and shown a month at a time; README § DWS API. A file can be loaded in each comparison's Data source, or in the Load flow data window, opened from the compliance panel: monthly flow for the Historical Comparison, and 12-minute or daily flow for the Real Time Comparison, chosen or dropped. The window uses the same importer (`importFile`) and puts the file in use in its comparison, in place of a gauge or the API. Sheet, units and year are then set in the comparison. A file is read in the browser and never sent anywhere.

## Gauge records

`static/data/gauges.json` holds `links`, the gauge that measures each node with the factor on its record, `records`, each gauge's monthly file as text, in the DWS format or as a table worked up from a daily file, `flows`, the stations with a `flows-<station>.json`, and `incomplete`, the months of each station that its daily record shows are not whole. That file holds the gauge's DWS `.day` file and its 12-minute readings, as text. Like the Desktop outputs, the text is parsed in the browser (`parseMon`, `parseGaugeFlows`). `gauges.json` loads with `index.json`, and the app does not start without it. A flows file loads when its gauge is first opened.

- A month flagged `#` is incomplete or missing and is left out of every mean, whatever figure it carries. The record panel still shows that figure, marked. The same goes for a `#` in a loaded file, through `cellNumber`.
- A table worked up from a daily file has `+` for a patched value and `-99.999` for none. A patched value is real: it counts in the means and is marked in the record, like a coded day. `-99.999` is treated like `#`. Otherwise the table does not say when days are missing, adding up the measured days alone, and can show a month with no measured day as `0.000`. So the build lists every month the gauge's daily record shows is not whole (`incomplete`), and those are left out unless they are patched. A table loaded by hand has no such check.
- In daily flow, code 170 or a blank is missing: a gap in the line, never a zero or a join. Codes 1 and 2 are clean. Any other code marks a real value, which counts in the means and is drawn as its own series (`isCoded`). A quality column in a loaded table or API response works the same way.
- A day's flow is the mean of its readings, however few there are, as the reference workbook does. A day in the `.day` record is taken from it and not from the readings.
- A node's factor multiplies its gauge's monthly volumes, daily flow and readings before anything is compared, and comes from outside the app. There is one factor per node, across both comparisons. A typed factor is the user's own, stored per node with the other choices, and clearing it goes back to the link's. The gauge's own panel always shows the record unfactored.
- A gauge's 12-minute readings can be drawn over its daily flow, a month at a time, in the Real Time Comparison and in the gauge's own panel ("Show 12-minute readings", off by default). The gauge panel offers the switch only for a gauge that has readings.
- A linked node starts on its gauge in each comparison the gauge has data for. A file already loaded stays in use until the user picks the gauge in Data source. Under a gauge the Real Time Comparison shows one month at a time, opening on the latest month with most of its days measured.
- A gauge opens from the map or from its node. The map's gauges are the live layer, so a gauge with a record can only be clicked while that layer has it. The node route always works.

## Users and access

On the host, Cloudflare Pages, nobody reaches any file of the site, `data/` included, unless two things hold. Cloudflare Access has signed them in, with a one-time code sent to their email address, and that address is on the site's list of users. Access proves who someone is; the list, which the site's admins keep, decides whether they may come in. Hosting and setting it up: `docs/hosting.md` § Access control.

| Path | Role |
|---|---|
| `functions/_middleware.ts` | Runs before every request. Verifies the Access token (`lib/access.ts`: RS256 with Access's published keys, cached for an hour and fetched again for an unknown key id at most once a minute) and looks the address up in the list (`lib/gate.ts`). Refuses with a page, or JSON for the app's own calls, each carrying its own `nosniff` and `frame-ancestors` headers, since `_headers` does not reach a response a Function makes. A change (POST, PATCH, DELETE) must come from the site's own origin. |
| `functions/lib/users.ts` | The rules. Only an admin lists, adds, removes, or makes and unmakes admins. Nobody removes themself or their own admin rights. Addresses are kept trimmed and lowercase. Every change is logged in `audit`. |
| `functions/lib/d1.ts`, `migrations/` | The list in Cloudflare D1. The last-admin rule is in each SQL statement, so two admins acting at once cannot leave the site with none. A change and its audit row go in one batch, a transaction. The table refuses an address that is not lowercase and trimmed. |
| `functions/api/` | `me` (who is signed in), `users` (list, add) and `users/<email>` (make or unmake admin, remove), JSON over `fetch`. |
| `src/lib/users/api.ts`, `src/lib/state/session.svelte.ts` | The app asks `api/me` once at start. Every call sends `X-Requested-With`, so an expired sign-in is a JSON 401 and not a sign-in page; a 401 from `api/me` sets `session.expired`, and the Users page then asks for a reload instead of saying there is no list. |
| `src/lib/components/users/UsersAdmin.svelte`, `src/routes/users/` | The Users page, offered in the nav to admins only. |

A copy served without `functions/`, such as `pnpm dev`, `pnpm preview` or the e2e servers, has no list: `api/me` is not found, the app shows no Users link, and everything else works as before. The e2e fixture answers `api/` with 404 by default, and `users.spec.ts` stands in for a host with a list. The first admin is added by the operator, once, straight into D1; after that, admins add everyone else. The list holds email addresses, so it lives only in D1, never in this repo.

## Layout

| Path | Purpose |
|---|---|
| `src/lib/ewr/parsers.ts` | File parsers, conversion and comparison arithmetic. Pure. |
| `src/lib/ewr/resolve.ts` | Which EC, method and file a node uses, and its notices. Pure. |
| `src/lib/ewr/types.ts` | Shared shapes. |
| `src/lib/ewr/format.ts` | Number format, series colours, file-kind labels. |
| `src/lib/ewr/importFlow.ts` | Reads flow files and API responses, by `FlowWant`; `xlsx` loads only when needed. The DWS API is not published, so the API format is an assumption: README § DWS API. |
| `src/lib/state/app.svelte.ts` | The single app state (`app`). Components read it and call its methods. |
| `src/lib/components/map` | `WmaMap.svelte`, the national map of WMAs, and `EwrMap.svelte`, one WMA's map, with popup (`NodePopup.svelte`), legend, basin zoom and search. `wma.ts` holds the WMAs and the geometry tests, `mapData.ts` the map's other pure logic, `mapStyle.ts` the layers and base map style, `catchments.ts` the live DWS boundaries and flow gauges, paged, with a time limit. |
| `src/routes` | `/`, the WMA chooser. `wma/[wma]/`, one WMA's map and compliance panel. `nodes/`, `notes/`, and `+error.svelte`. |
| `src/lib/components/compliance` | Node panel, Historical and Real Time Comparison, `GaugePanel.svelte`, a gauge's published monthly volumes, and `LoadFlowDialog.svelte`, the Load flow data window. `compare.ts` holds table rows and chart series. |
| `src/lib/components/charts` | uPlot wrapper. |
| `src/lib/components/nodes` | Nodes table and data notes. |
| `src/lib/components/viewer` | File viewer dialog. |
| `tools/` | `build-rivers.ts` for `static/geo`, `build_geo.py` for the private quaternaries file, `sync-private.sh` and `sample-data.mjs`, which fill `static/data`, `fetch-tiles.sh` for the base map, `check-live-services.ts`, the contract check on the live layers, and `deploy.sh` with `deploy-check.mjs`, the Cloudflare Pages deploy and the checks it makes first (`docs/hosting.md` § Build). See README. |
| `e2e/fixtures` | Synthetic flow files and the sample dataset, each with the script that writes it. |
| `vite.config.ts` | Adapter, `BASE_PATH` and the content security policy. See `docs/hosting.md`. |

## Conventions

- SvelteKit 3: import with `#lib/...` and include the extension (`#lib/ewr/parsers.ts`, `#lib/state/app.svelte.ts`). `$lib` is removed. Paths take no leading slash and routes end in one, because each is built as `<route>/index.html`: `resolve('nodes/')`, `asset('data/index.json')`. The home route is `resolve('/')`.
- Svelte 5 runes only. Tabs for indentation, single quotes.
- Numbers on screen come from `src/lib/ewr`, never recomputed in a component.
- Conversion uses `DAYS` in `parsers.ts` (Feb = 28), the same as the reference compliance workbook.
- The Units switch covers both comparisons, m³/s by default. The Real Time Comparison compares in m³/s and only its display changes: in Mm³ a day or reading is the month's volume at that flow, by `DAYS`, so a flow and an EWR line keep their order and status in either unit.
- Chart line names are exact: `EWR Monthly Requirement`, `Drought EWR`, `Urgent action required`. Every node draws all three: `ewrLines` derives `urgent` for both methods.
