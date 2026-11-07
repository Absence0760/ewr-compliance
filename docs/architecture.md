# Architecture

A static SvelteKit 3 app (`adapter-static`, `ssr = false`) with Svelte 5 runes and TypeScript.
Flow files stay in the browser, and everything else is static JSON in `static/data`. The server
parts are `server/`, the sign-in and user API that decides who may open the site (§ Users and
access), and `pipeline/`, which keeps the DWS store the app reads (§ DWS store). Neither ever sees a
flow file a user loads.

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

The browser never calls DWS. A pipeline in AWS af-south-1 pulls each linked gauge's flow from DWS on a schedule into our own store, and the site serves it same-origin under `dws/` (CloudFront `/dws/*` to the store's bucket with origin path `/serve`, so `dws/index.json` is the key `serve/dws/index.json`). Data source > DWS (kept current) reads it. Decisions, recorded with the operator:

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

The station names in the index are client material: the store sits behind the sign-in, and no list of them goes in this repo.

### The pipeline

`pipeline/` writes the store: a Lambda, its own pnpm package beside the app (not a workspace member), ported from `project-water-management`'s DWS pass. Its infrastructure is `infra/dws.tf` and `infra/dws_backfill.tf`; how it is run and watched, `docs/hosting.md` § The DWS store.

- **Source.** The HyData daily table (`HyData.aspx`, `DataType=Daily`, `SiteType=RIV`) that WM reads, two years a request, read defensively (`src/hydata.ts`): no table, another header, a flow column in another unit, an impossible or repeated date, a flow above 100 000 m³/s or a code too wide for its column refuses the page. A flow column holding text or a negative figure is written blank, a missing day, as the app treats a -9999 elsewhere; codes are kept as DWS gives them, for the app's rules to read. Monthly volumes and 12-minute readings are not pulled yet (the plan's Q1): `readings` is `""` and `monthly` is `false`.
- **The app's own readers check what it writes.** The daily file is EWR's `.day` layout (date in 1-8, flow in 10-18, code in 20-24), rendered then read back with `parseDay` row for row; the flows file goes through `parseGaugeFlows` and the index through `parseDwsIndex` before either is stored. The pipeline imports them from `src/lib/ewr` by relative path, and `pipeline/src/contract.test.ts` reads its output with them, so a change on either side that the other can't read fails CI.
- **Merge.** A later pull wins day by day; a day a later page doesn't list keeps what an earlier pull stored, so a short or empty page never drops a day. `covers` is the merged file's first and last day.
- **Times.** `fetchedAt` is when the station's last good pull ended (UTC, `Z`). `stale` is set when its last pull of a window reaching today is more than 3 days old (`STALE_AFTER_DAYS`), and a station only backfilled is stale until the daily run reaches it.
- **Its own keys** in the bucket, which CloudFront can't read: `config/stations.json`, the list (`tools/dws-stations.sh`); `raw/<station>/daily/<from>_<to>.txt`, each page as sent; `state/status.json`, per station its last good and current pull, its `covers`, and how the last run stopped; `lease/dws.json`, the one run allowed at a time. Per station it writes the flows file, then the raw page, then the status, then the index, so a stored raw page means its days are merged (the backfill's resume test) and the index never lists more than is written. The sample's store, `e2e/fixtures/sample-store`, is written by `make-sample-data.mjs` and served to the specs by `serveStore` in `e2e/support/app.ts`; it is not copied to `static/`.

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

On the hosted site (AWS, `docs/hosting.md`) nobody reaches any file, `data/` included, without CloudFront signed cookies, and only the API issues them, to people on the site's list after an emailed code. The list, the codes, the sessions and the audit rows are one DynamoDB table. The logic is the private package `auth-kit` (codes, sessions, the user rules, the store, bootstrap, recovery, erasure); this repo holds the routes, what the gate protects, the pages and the Terraform.

| Part | What it does |
|---|---|
| `server/` | Its own pnpm package and lockfile, so the root app, e2e and fork PRs install without access to `auth-kit` (pinned by tag; `pnpm-workspace.yaml` allows its build by exact commit). `src/app.ts` is the routes; `src/lambda.ts` builds them at cold start from the environment and two secrets; `src/cloudfront.ts` signs the cookies; `src/operator.ts` is the operator's commands. `pnpm build` bundles `dist/api.zip`. |
| `/api/auth/*` | `code` answers 202 for any address, padded to a fixed time (`withMinimumLatency`), and mails a 6-digit code only to a listed one. `verify` sets the session cookie (`__Host-ewr_session`, an HS256 JWT, 7 days) and the four CloudFront cookies for `https://<domain>/*`, 15 minutes, never past the session. `refresh` re-reads the user and renews the file cookies. `logout` and `logout-everywhere` revoke. |
| `/api/me`, `/api/users`, `/api/users/<id>`, `/api/audit` | Who is signed in; the list and its changes (admins only), each one transaction with its audit row. Every call re-reads the session and the user, so a removed user gets 401 at once, and loses the files within 15 minutes. |
| Rules every route keeps | CloudFront's `X-Origin-Secret` or a bare 404. "Not signed in" is 401 JSON, never 403 (CloudFront swaps every 403 for the sign-in page), and auth-kit's "only an admin" goes out as 404. A write needs `Origin: https://<domain>` and a JSON body (415 otherwise). Every answer is `no-store`. `code` and `verify` take at least 1 second, and a step past that logs `auth.slow`. Logs carry event names and opaque ids, never an address; `auth.locked` and `auth.slow` have alarms. A WAF block is 429 JSON, never 403. |
| `static/signin/` | The sign-in page, the one unsigned path: its own JS, CSS and CSP, absolute paths (CloudFront also serves it for any 403, at that address), nothing from `_app/`. An address, the code, then `?next=`, which `next.js` keeps to a path on this site. A live session skips the code, but only at `/signin/` itself (served for a 403 elsewhere, going straight back could loop) and not just after Sign out (`signedout=1`). |
| `src/lib/users/api.ts`, `src/lib/state/session.svelte.ts` | The app asks `api/me` at start. While signed in it refreshes every 10 minutes and when a tab comes back after 5; a refresh with no answer (a 429, a 5xx) is not counted as one and is tried again a minute later; a 401 from the API sends the person to `signin/?next=<here>`. A sign-out the API doesn't confirm says so and stays. Sign out is in the app bar. |
| `src/lib/users/siteFetch.ts` | Every fetch of the site's own files (`data/`, `geo/`, `dws/`, the privacy notice) goes through `siteFetch`, which sends `X-Requested-With`, so the edge answers lapsed file cookies with 401 JSON rather than a redirect the fetch would follow. A 401 calls `session.unauthorized()`: one refresh (shared by every fetch refused meanwhile) and one more try, then `signin/?next=<here>`; before the session is known, sign-in at once. Requests to other origins (ArcGIS) never carry the header. `expired-signin.spec.ts` stands in for the edge. |
| `src/lib/components/users/UsersAdmin.svelte`, `src/routes/users/` | The Users page, for admins: add, make or unmake admin, remove (confirmed), by user id. |
| `tools/first-admin`, `recover-admin`, `clear-lock`, `erase-user` | The operator's, with their own AWS profile, through `server/src/operator.ts`: bootstrap the first admin, the break-glass, clearing a sign-in lockout without changing a role (`docs/hosting.md` § First admin, and recovery), and erasure. Each asks for the address. |

A copy served without the API, such as `pnpm dev`, `pnpm preview` or the e2e servers, has no list: `api/me` is not found, the app shows no Users link or Sign out, and everything else works. The e2e fixture answers `api/` with 404 by default; `users.spec.ts` and `signin.spec.ts` stand in for the API. The list holds email addresses, so it lives only in DynamoDB, never in this repo.

## Hosting on AWS

The private hosting plan, in `infra/` (Terraform, flat `*.tf`, applied by the operator from the workstation, never by CI). What each file makes, and the operator's steps: `infra/README.md`. What the host does: `docs/hosting.md` § AWS; the order to go live in, and the checks after: § Deploy readiness there.

- **Skeleton (P1).** Providers for af-south-1 and us-east-1, `default_tags`, the S3 backend whose bucket is in the gitignored `backend.config`, alert topics, budgets, and the lookup of the bootstrap's OIDC deploy role with a postcondition on its trust. The deploy role is never given S3 or CloudFront; it may update the code of the API, the DWS pipeline and any Lambda named in `deploy_lambda_functions`.
- **Gated site (P2, `site_enabled`).** A private bucket behind CloudFront (OAC). The default behaviour trusts one key group, so every path needs CloudFront signed cookies, which the API signs from P3; `/signin/*` is the one unsigned path. The viewer-request function (`infra/edge_functions.tf`, run as code by `tools/edge-functions.test.ts`) redirects a request with no live session to `/signin/`, or answers 401 JSON to one with `X-Requested-With`, and serves folder paths their `index.html`. A response-headers policy replaces `static/_headers`, and WAF rate-limits each address.
- **Sign-in (P3, `auth_enabled`).** `infra/auth.tf`: the user table (PITR, TTL on `ttl`, deletion protection), the API Lambda behind `/api/*` (CachingDisabled, cookies and `Origin` forwarded, the origin secret stamped), its keys in a write-only runtime secret, IAM limited to `auth-kit`'s actions on the table, SES as `no-reply@` only and its two secrets, SES in af-south-1 with DKIM, MAIL FROM and DMARC, and alarms. CI deploys its code (`deploy-lambdas.yml`).
- **DWS store (P4, `dws_enabled`).** `infra/dws.tf` and `infra/dws_backfill.tf`: the store's bucket (CloudFront reads `serve/dws/*` only, signed, through the `/dws/*` behaviour), the pipeline Lambda with no async retries and a DLQ, its grants held to its prefixes and the lease key, the daily rule (disabled until `dws_schedule_enabled`), an empty secret for a future DWS API key, the Step Functions backfill over date windows that retries nothing that would ask DWS again, and the lag, stopped, failed, DLQ and backfill alarms. CI deploys its code (`deploy-lambdas.yml`, `pipeline@X.Y.Z`).
- **Tests.** `infra/tests/*.tftest.hcl`, plan-only against mocked providers, pin the region rule, the deploy role's scope, the site's wiring, the WAF, the headers, the sign-in's scoping and the DWS store's (`dws.tftest.hcl`). `bin/check-infra.sh` runs fmt, validate and these in a temporary copy, and is CI's `Terraform` job, which the `CI gate` needs.

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
| `tools/` | `build-rivers.ts` for `static/geo`, `build_geo.py` for the private quaternaries file, `sync-private.sh` and `sample-data.mjs`, which fill `static/data`, `fetch-tiles.sh` for the base map, `check-live-services.ts`, the contract check on the live layers, `deploy.sh` with `deploy-check.mjs`, the S3 deploy and the checks it makes first (`docs/hosting.md` § Build), `dws-stations.sh` and `dws-backfill-plan.mjs`, the DWS store's station list and backfill plan, `first-admin`, `recover-admin`, `clear-lock` and `erase-user` (§ Users and access), and `edge-functions.test.ts`, which runs the CloudFront function in `infra/` as code. See README. |
| `server/`, `static/signin/` | The sign-in and user API, and the sign-in page (§ Users and access). |
| `pipeline/` | The DWS store's pipeline Lambda, its own pnpm package (§ DWS store): `src/hydata.ts` reads DWS's page and writes the `.day` file, `src/polite.ts` is its one HTTP client, `src/lease.ts` the one-run-at-a-time lease, `src/run.ts` the daily run and a backfill window, `src/handler.ts` the entry. `fixtures/` holds synthetic `X0H001` replies only. `pnpm build` bundles `dist/pipeline.zip`. |
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
