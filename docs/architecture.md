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

## Loading flow

Observed flow comes from a linked gauge, the DWS store, or a file. Each comparison's Data source lists these as radio buttons, each saying what it holds (`FlowImport.svelte`). A linked node starts on its gauge where the gauge has data for the comparison; otherwise a node starts on the DWS store if it can, and on Spreadsheet if not. A file can be loaded in each comparison's Data source, or in the Load flow data window, opened from the compliance panel: monthly flow for the Historical Comparison, and 12-minute or daily flow for the Real Time Comparison, chosen or dropped. The window uses the same importer (`importFile`) and puts the file in use in its comparison, in place of a gauge or the store. Sheet, units and year are then set in the comparison. A file is read in the browser and never sent anywhere.

## DWS store

The browser never calls DWS. A pipeline in AWS af-south-1 pulls each linked gauge's flow from DWS on a schedule into our own store, and the site serves it same-origin under `dws/` (CloudFront `/dws/*` to the store's `serve/` prefix). Data source > DWS (kept current) reads it. Decisions, recorded with the operator:

- It is offered only at a node with a linked gauge (`app.link`), for that link's station. A node with no link has no store source.
- It applies the node's factor exactly as the gauge source does (`dwsRt`, `dwsHist`, through `gaugeSeries` and `gaugeFlow`): one factor per node, scaling the node's observed flow and never a record as shown for the gauge itself.
- The Real Time Comparison reads the station's daily flow and readings (`flows-<station>.json`), shown a month at a time, as a gauge's are.
- The Historical Comparison reads monthly volumes only from `monthly-<station>.json`, when the index says there is one. Without it the source cannot be picked there, and the gauge's monthly record in `gauges.json` stays what the comparison uses: the store's option never stands for data it does not hold.
- Each comparison shows the station's `fetchedAt`, in SAST, and the days it covers, and an out-of-date notice when the pipeline has set `stale`. The app never works staleness out from the clock: the pipeline knows its schedule.
- `dws/index.json` is read once at start, revalidated (`cache: 'no-cache'`). A 404, such as on `pnpm dev`, `pnpm preview` or the e2e servers, or any other failure, leaves the source unpickable with the reason as its line, after that one request. A station's files are read when its source is first used, and only once the index lists it.

The files, which the pipeline (P4) writes exactly so. `src/lib/ewr/dwsStore.ts` reads and checks them:

| Path | Holds |
|---|---|
| `dws/index.json` | `{ "version": 1, "stations": { "<station>": { "fetchedAt", "covers": { "from", "to" }, "stale", "monthly" } } }`. `fetchedAt` is when the last pull that got the station's data ended, ISO 8601 with its offset. `covers` is the first and last day of its daily flow, `YYYY-MM-DD`. `stale` is `true` when the pulls have stopped keeping it current. `monthly`, optional and `false` when absent, says `monthly-<station>.json` is there. A station is listed only once its flows file is written. Another `version`, or an entry missing a field, is refused whole, never half-read. |
| `dws/flows-<station>.json` | `{ "daily": "<a DWS .day file>", "readings": "<12-minute readings, as CSV>" }`, the `GaugeFlowFile` of `static/data/flows-<station>.json`, read by `parseGaugeFlows` unchanged. Either may be `""`. Code 170 or a blank in the daily flow is a missing day. |
| `dws/monthly-<station>.json` | Optional. `{ "monthly": "<a DWS .mon file, or a table worked up from a daily file>", "incomplete": ["YYYY-MM", …] }`, as a record and its `incomplete` list are in `gauges.json`, read by `parseMon`. |

The station names in the index are client material: the store sits behind the sign-in, and no list of them goes in this repo. The sample's store, `e2e/fixtures/sample-store`, is written by `make-sample-data.mjs` and served to the specs by `serveStore` in `e2e/support/app.ts`; it is not copied to `static/`.

`localStorage` (`src/lib/state/storage.ts`) keeps the EC basis and each node's choices. The DWS API addresses an older version kept there, `histApi` and `rtApi`, are dropped the first time this one runs.

## Gauge records

`static/data/gauges.json` holds `links`, the gauge that measures each node with the factor on its record, `records`, each gauge's monthly file as text, in the DWS format or as a table worked up from a daily file, `flows`, the stations with a `flows-<station>.json`, and `incomplete`, the months of each station that its daily record shows are not whole. That file holds the gauge's DWS `.day` file and its 12-minute readings, as text. Like the Desktop outputs, the text is parsed in the browser (`parseMon`, `parseGaugeFlows`). `gauges.json` loads with `index.json`, and the app does not start without it. A flows file loads when its gauge is first opened.

- A month flagged `#` is incomplete or missing and is left out of every mean, whatever figure it carries. The record panel still shows that figure, marked. The same goes for a `#` in a loaded file, through `cellNumber`.
- A table worked up from a daily file has `+` for a patched value and `-99.999` for none. A patched value is real: it counts in the means and is marked in the record, like a coded day. `-99.999` is treated like `#`. Otherwise the table does not say when days are missing, adding up the measured days alone, and can show a month with no measured day as `0.000`. So the build lists every month the gauge's daily record shows is not whole (`incomplete`), and those are left out unless they are patched. A table loaded by hand has no such check.
- In daily flow, code 170 or a blank is missing: a gap in the line, never a zero or a join. Codes 1 and 2 are clean. Any other code marks a real value, which counts in the means and is drawn as its own series (`isCoded`). A quality column in a loaded table works the same way.
- A day's flow is the mean of its readings, however few there are, as the reference workbook does. A day in the `.day` record is taken from it and not from the readings.
- A node's factor multiplies its gauge's monthly volumes, daily flow and readings before anything is compared, and comes from outside the app. There is one factor per node, across both comparisons. A typed factor is the user's own, stored per node with the other choices, and clearing it goes back to the link's. The gauge's own panel always shows the record unfactored.
- A gauge's 12-minute readings can be drawn over its daily flow, a month at a time, in the Real Time Comparison and in the gauge's own panel ("Show 12-minute readings", off by default). The gauge panel offers the switch only for a gauge that has readings.
- A linked node starts on its gauge in each comparison the gauge has data for. A file already loaded stays in use until the user picks the gauge in Data source. Under a gauge the Real Time Comparison shows one month at a time, opening on the latest month with most of its days measured.
- A gauge opens from the map or from its node. The map's gauges are the live layer, so a gauge with a record can only be clicked while that layer has it. The node route always works.

## Users and access

> **Superseded.** The Cloudflare design described here is being replaced by hosting on AWS af-south-1, with sign-in and user management from the shared private package `auth-kit`, per the private hosting plan (phases P1–P6). Nothing is live. This section stays as it is until P6 rewrites it; don't extend the Cloudflare code.

On the host, Cloudflare Pages, nobody reaches any file of the site, `data/` included, unless two things hold. Cloudflare Access has signed them in, with a one-time code sent to their email address, and that address is on the site's list of users. Access proves who someone is; the list, which the site's admins keep, decides whether they may come in. The list in D1 is the source of truth. Access's policy includes only an Access group the site keeps in step with it, so Access sends a code to no one else, and the middleware checks the list again on every request. Hosting and setting it up: `docs/hosting.md` § Access control.

| Path | Role |
|---|---|
| `functions/_middleware.ts` | Runs before every request. Verifies the Access token (`lib/access.ts`: RS256 with Access's published keys, cached for an hour and fetched again for an unknown key id at most once a minute) and looks the address up in the list (`lib/gate.ts`). Refuses with a page, or JSON for the app's own calls, each carrying its own `nosniff` and `frame-ancestors` headers, since `_headers` does not reach a response a Function makes. A change (POST, PATCH, DELETE) must come from the site's own origin. |
| `functions/lib/users.ts` | The rules. Only an admin lists, adds, removes, or makes and unmakes admins. Nobody removes themself or their own admin rights. Addresses are kept trimmed and lowercase. Every change is logged in `audit`. |
| `functions/lib/d1.ts`, `migrations/` | The list in Cloudflare D1. The last-admin rule is in each SQL statement, so two admins acting at once cannot leave the site with none. A change and its audit row go in one batch, a transaction, which also deletes audit rows older than `AUDIT_RETENTION_MONTHS` (24), counted back from the change's own time. The table refuses an address that is not lowercase and trimmed. |
| `functions/lib/accessGroup.ts`, `functions/lib/membership.ts` | The Access group. After an add or a removal, `membership.ts` sends the whole list to `accessGroup.ts`, which reads the group and replaces its include rules, one email rule per address, through the Cloudflare API, keeping its name and other rules; on a removal it then ends that user's Access sessions. Making or unmaking an admin changes no membership and sends nothing. A failed call leaves the D1 change standing and comes back in the reply (`access`, `sessions`) for the page to show; without `CF_ACCOUNT_ID`, `ACCESS_GROUP_ID` and the secret `CF_API_TOKEN` the state is "not configured". A reason never carries the token or a response body. |
| `functions/api/` | `me` (who is signed in), `users` (list, add), `users/<email>` (make or unmake admin, remove) and `users/sync` (GET whether the group is kept in step, POST sync it now), JSON over `fetch`. |
| `src/lib/users/api.ts`, `src/lib/state/session.svelte.ts` | The app asks `api/me` once at start. Every call sends `X-Requested-With`, so an expired sign-in is a JSON 401 and not a sign-in page; a 401 from `api/me` sets `session.expired`, and the Users page then asks for a reload instead of saying there is no list. |
| `src/lib/components/users/UsersAdmin.svelte`, `src/routes/users/` | The Users page, offered in the nav to admins only. After a change Access was not told of, it says "Saved, but Cloudflare Access was not updated" with the reason; Sync with Access sends the whole list again; and a host without the group settings gets a notice that Access is not kept in step. |

A copy served without `functions/`, such as `pnpm dev`, `pnpm preview` or the e2e servers, has no list: `api/me` is not found, the app shows no Users link, and everything else works as before. The e2e fixture answers `api/` with 404 by default, and `users.spec.ts` stands in for a host with a list. The first admin is added by the operator, once, straight into D1; after that, admins add everyone else. The list holds email addresses, so it lives only in D1, never in this repo.

## Hosting on AWS

Phases P1 and P2 of the private hosting plan, in `infra/` (Terraform, flat `*.tf`, applied by the operator from the workstation, never by CI). What each file makes, and the operator's steps: `infra/README.md`. What the host does: `docs/hosting.md` § AWS, as built so far.

- **Skeleton (P1).** Providers for af-south-1 and us-east-1, `default_tags`, the S3 backend whose bucket is in the gitignored `backend.config`, alert topics, budgets, and the lookup of the bootstrap's OIDC deploy role with a postcondition on its trust. The deploy role is never given S3 or CloudFront; from P3 it may update named Lambdas.
- **Gated site (P2, `site_enabled`).** A private bucket behind CloudFront (OAC). The default behaviour trusts one key group, so every path needs CloudFront signed cookies, which the API signs from P3; `/signin/*` is the one unsigned path. The viewer-request function (`infra/edge_functions.tf`, run as code by `tools/edge-functions.test.ts`) redirects a request with no live session to `/signin/`, or answers 401 JSON to one with `X-Requested-With`, and serves folder paths their `index.html`. A response-headers policy replaces `static/_headers`, and WAF rate-limits each address.
- **Tests.** `infra/tests/*.tftest.hcl`, plan-only against mocked providers, pin the region rule, the deploy role's scope, the site's wiring, the WAF and the headers. `bin/check-infra.sh` runs fmt, validate and these in a temporary copy, and is CI's `Terraform` job, which the `CI gate` needs.

## Privacy notice

`privacy/` shows the privacy notice, linked from the end of the app bar on every page (`+layout.svelte`; not a footer, which would take height from the map). It renders even when the data fails to load, since it needs none of it. Its text is not in this repo: it is `static/data/privacy.md`, the real notice from the private repo through `pnpm data:private`, or a made-up one from `make-sample-data.mjs` in the sample. `src/lib/privacy/markdown.ts` reads a little Markdown (headings `#` to `###`, drawn as h2 to h4, paragraphs, lists, `**bold**`, links) into blocks the page draws with Svelte's own elements. No text becomes HTML, and a link keeps its address only when it is `https:` or `mailto:`. `src/lib/privacy/notice.svelte.ts` fetches it once. What the site keeps, and how a person is erased: `docs/hosting.md` § Personal data.

## Layout

| Path | Purpose |
|---|---|
| `src/lib/ewr/parsers.ts` | File parsers, conversion and comparison arithmetic. Pure. |
| `src/lib/ewr/resolve.ts` | Which EC, method and file a node uses, and its notices. Pure. |
| `src/lib/ewr/types.ts` | Shared shapes. |
| `src/lib/ewr/format.ts` | Number format, series colours, file-kind labels. |
| `src/lib/ewr/importFlow.ts` | Reads flow files, by `FlowWant`; `xlsx` loads only when needed. |
| `src/lib/ewr/dwsStore.ts` | The DWS store's formats, and what Data source says about it: § DWS store. Pure. |
| `src/lib/state/app.svelte.ts` | The single app state (`app`). Components read it and call its methods. |
| `src/lib/state/storage.ts` | What is kept in `localStorage`, and the keys an older version kept that are dropped. |
| `src/lib/components/map` | `WmaMap.svelte`, the national map of WMAs, and `EwrMap.svelte`, one WMA's map, with popup (`NodePopup.svelte`), legend, basin zoom and search. `wma.ts` holds the WMAs and the geometry tests, `mapData.ts` the map's other pure logic, `mapStyle.ts` the layers and base map style, `catchments.ts` the live DWS boundaries and flow gauges, paged, with a time limit. |
| `src/routes` | `/`, the WMA chooser. `wma/[wma]/`, one WMA's map and compliance panel. `nodes/`, `notes/`, `privacy/`, and `+error.svelte`. |
| `src/lib/components/compliance` | Node panel, Historical and Real Time Comparison, `GaugePanel.svelte`, a gauge's published monthly volumes, and `LoadFlowDialog.svelte`, the Load flow data window. `compare.ts` holds table rows and chart series. |
| `src/lib/components/charts` | uPlot wrapper. |
| `src/lib/components/nodes` | Nodes table and data notes. |
| `src/lib/components/viewer` | File viewer dialog. |
| `tools/` | `build-rivers.ts` for `static/geo`, `build_geo.py` for the private quaternaries file, `sync-private.sh` and `sample-data.mjs`, which fill `static/data`, `fetch-tiles.sh` for the base map, `check-live-services.ts`, the contract check on the live layers, `deploy.sh` with `deploy-check.mjs`, the S3 deploy and the checks it makes first (`docs/hosting.md` § Build), and `edge-functions.test.ts`, which runs the CloudFront function in `infra/` as code. See README. |
| `infra/`, `bin/check-infra.sh` | Terraform for the AWS hosting (§ Hosting on AWS), and its credential-free checks. `infra/README.md`. |
| `e2e/fixtures` | Synthetic flow files, the sample dataset and the sample DWS store, each with the script that writes it. |
| `vite.config.ts`, `src/csp.ts` | Adapter, `BASE_PATH` and the content security policy, whose `connect-src` `src/csp.ts` builds. See `docs/hosting.md`. |

## Conventions

- SvelteKit 3: import with `#lib/...` and include the extension (`#lib/ewr/parsers.ts`, `#lib/state/app.svelte.ts`). `$lib` is removed. Paths take no leading slash and routes end in one, because each is built as `<route>/index.html`: `resolve('nodes/')`, `asset('data/index.json')`. The home route is `resolve('/')`.
- Svelte 5 runes only. Tabs for indentation, single quotes.
- Numbers on screen come from `src/lib/ewr`, never recomputed in a component.
- Conversion uses `DAYS` in `parsers.ts` (Feb = 28), the same as the reference compliance workbook.
- The Units switch covers both comparisons, m³/s by default. The Real Time Comparison compares in m³/s and only its display changes: in Mm³ a day or reading is the month's volume at that flow, by `DAYS`, so a flow and an EWR line keep their order and status in either unit.
- Chart line names are exact: `EWR Monthly Requirement`, `Drought EWR`, `Urgent action required`. Every node draws all three: `ewrLines` derives `urgent` for both methods.
