# Hosting

The app is a folder of static files, `server/` is the sign-in API in front of it, and `pipeline/` keeps the DWS store it reads. `tools/deploy.sh` deploys the files to the AWS site below; CI deploys the API and the pipeline (`.github/workflows/deploy-lambdas.yml`). Every phase of the private hosting plan is built (P1 to P6) and checked offline; nothing is applied yet. Going live is the operator's steps in order, with the checks at the end: § Deploy readiness.

## AWS

`infra/` holds the Terraform; `infra/README.md` has the operator's steps, one command at a time, and what each file makes. Nothing is applied yet.

- **Account and region.** The `ewr-compliance` sub-account, made by the estate bootstrap. The workload is in af-south-1, and `aws_region` refuses anything else unless `data_outside_south_africa` is set. Terraform state is in the bootstrap's us-east-1 bucket, named in the gitignored `infra/backend.config`; the values are in `infra-secrets`.
- **Alerts and cost.** Two SNS topics mail the operator; monthly and daily budgets; Cost Anomaly Detection once turned on.
- **Deploy role.** The bootstrap's OIDC role, for the `production` environment only. It may update the code of the API (once `auth_enabled`), of the DWS pipeline (once `dws_enabled`) and of any Lambda in `deploy_lambda_functions`, and nothing else. It can never write the site bucket: the site and its data go up only from the workstation.
- **The site** (`site_enabled`). A private, versioned S3 bucket read by CloudFront through OAC. Every path needs CloudFront signed cookies (the default behaviour trusts one key group) except `/signin/*`. The viewer-request function sends a request without a live `CloudFront-Policy` cookie to `/signin/?next=…`, or answers `401` JSON when it carries `X-Requested-With`, and serves a folder path its `index.html` (with a `301` to add the slash). CloudFront's own `403`, for a cookie whose signature fails, shows the sign-in page. The private key that signs the cookies is in a Secrets Manager secret Terraform creates empty; the operator puts it in from a file. `/api/*` goes to the API (§ Access control). WAF limits each address on every path and, more tightly, on `/api/auth/*`. Price class All, for South African edges.
- **Headers.** A response-headers policy sets the headers below (the retired `static/_headers` file's), plus HSTS, and `infra/tests/security_headers.tftest.hcl` pins it. `Cache-Control` is set per object by `tools/deploy.sh` instead: § Headers.
- **Sign-in** (`auth_enabled`, `infra/auth.tf`). The API Lambda, the user table and SES: § Access control.
- **The DWS store** (`dws_enabled`, `infra/dws.tf`, `infra/dws_backfill.tf`). The store's bucket, the pipeline Lambda, its daily rule and its backfill, served signed under `/dws/*`: § The DWS store.

## The DWS store

DWS answers only South African networks, so the app's "DWS (kept current)" source reads our own copy, pulled in af-south-1. How the files look and how the app reads them: `docs/architecture.md` § DWS store. The operator's steps, one command at a time: H11 in `infra/README.md`.

- **What runs.** `pipeline/`, a Lambda with no VPC. A daily EventBridge rule (06:00 SAST, made disabled until `dws_schedule_enabled`) runs it once; it pulls each listed station whose last current pull is 20 hours old, the newest two years, one request a second, and stops at the Lambda's deadline. The Step Functions backfill runs it once a date window, one window at a time with a pause after each, for every listed station; a window already stored for a station is skipped, so starting the same plan again resumes it.
- **The station list** is `config/stations.json` in the store's bucket, every river gauge a node links to in the private repo's `gauges.json`. `tools/deploy.sh real` uploads it after the site (`tools/dws-stations.sh`); the sample deploy uploads none. It never passes through GitHub: station codes are client material, and live only in the private repo, the bucket and the pipeline's log group, where a code appears only beside a failed page's fixed label. The backfill's input is date windows only.
- **Politeness.** One run at a time (a lease object taken by S3 conditional writes), one request a second, Retry-After honoured within the run's time, and no request outliving the run. An HTTP 403, throttling the run can't wait out, DWS's ScriptServer error page, or five stations running that DWS didn't answer stops the run at once, and nothing retries it: not Lambda, EventBridge or the backfill. The runs after it then ask DWS nothing, daily or backfill, for 20 hours after a 403 and an hour after the others; a pull by hand can override that with `"ignoreStop": true` in its event, once the reason is understood. A station whose own page fails another way is skipped and tried again next run. Conditional GETs are sent, but only a second pull of the same day's window can use them.
- **What it keeps.** Each page as DWS sent it (`raw/`), and per station one daily file, merged: a later pull wins day by day, and a day a later page doesn't list keeps what an earlier pull stored. The daily file is written in EWR's `.day` layout and read back with the app's own parser before it is stored, and the index with the app's own reader. A station's file is marked out of date when its last current pull is more than 3 days old. Monthly volumes and 12-minute readings wait for the plan's Q1.
- **Alarms** (the regional topic). `dws-lag`: the oldest station's last current pull is more than `dws_lag_alarm_days` old, or no run reported for two days. `dws-stopped`: DWS stopped a run (`refused` is a 403: don't run it by hand until the reason is understood). `dws-failed`: the pipeline failed for a reason of its own (the store, a bad event, a backfill station's page). `dws-dlq`: a daily run failed or timed out. `dws-backfill-failed`: an execution ended; its error is the failed window's. The pipeline's errors leave it by name only (`DwsRefused`, `DwsThrottled`, `DwsServerError`, `DwsDown`, `DwsCoolingDown`, `PipelineFailed`, ...), so no station reaches the DLQ or an execution's history.
- **The DWS API key**, when DWS issues one, goes into the empty `ewr-compliance/dws-api-key` secret from a file (H11). Nothing reads it yet.

## The data is the decision

A build publishes whatever is in `static/data`. This repo holds only the synthetic sample, which is invented, so a build of it shows made-up nodes and numbers and is no use for real compliance work.

A real deployment must run `pnpm data:private` before `pnpm build`, on a machine that has the private repo. **That publishes the real data.** Every file in `static/data` is copied into `build/data/` and can be downloaded by anyone who can load the site, whatever the app shows. Those files are not under the MIT licence and all rights remain with their owners: read `NOTICE.md`. So hosting real data needs the operator's decision first, and the client's agreement (H12). On AWS every file is behind the sign-in (§ Access control); on any other host, the host needs its own access control. The private repository being private does not make the host private.

CI builds the sample only and has no access to the private repo, so a real build never comes from it: `tools/deploy.sh real` builds it on the operator's workstation.

## Access control

Nobody reaches a file of the site, `data/` included, without CloudFront signed cookies, and only the API (`server/`, on the private package `auth-kit`) issues them: to an address on the site's list, after a 6-digit code sent to it. How it works: `docs/architecture.md` § Users and access. What Terraform makes: `infra/auth.tf`.

- **The list** is one DynamoDB table in af-south-1 (`ewr-compliance-users`): users, the admin count, codes and throttles (keyed by an HMAC of the address, so a stranger's address is never stored), revoked sessions, and the audit log. Admins keep it on the Users page; every change is one transaction with its audit row, and the site always keeps an admin.
- **Codes** are valid 10 minutes, spent after 3 wrong tries, at most one a minute and 10 a day an address; 5 wrong codes in a row lock the address for a while (`auth.locked` alarms). Anyone can set off a lock against an address they know, so the operator can clear one (below). A lock stops only signing in by code: it never ends a live session or blocks a signed-in admin. Nothing says whether an address is listed, by answer or by timing.
- **Sessions** are an HttpOnly `__Host-` cookie for 7 days. The files' cookies last 15 minutes and the app renews them while it is open. Every API call re-reads the user: a removed user is refused by the API at once, and the files close to them within 15 minutes (Q3 in the plan accepts that).
- **Mail** goes from `no-reply@<domain>` through SES in af-south-1, DKIM-signed, over TLS only.
- **Keys.** The code key, the session key and the CloudFront origin secret are Terraform `random_password`s in the API's runtime secret (state holds them, encrypted, as the estate standard allows); the CloudFront private key is the operator's, put in by hand (H7). None is in the Lambda's environment, which the CI deploy role can read.

**Cookies.** The site sets these and no others: the session cookie `__Host-ewr_session` (HttpOnly, Secure, SameSite=Strict, 7 days) and the four CloudFront cookies (`CloudFront-Policy`, `CloudFront-Signature`, `CloudFront-Key-Pair-Id`, `CloudFront-Hash-Algorithm`, 15 minutes), all set by the API. They are strictly necessary to reach the site, so they need no consent banner. The app's own code reads and writes no cookie, and there are no analytics; its settings are in `localStorage`, never sent anywhere.

### First admin, and recovery

The operator adds the first admin once, with their own AWS profile (H9 in `infra/README.md`); admins add everyone else on the Users page. Each tool asks for the address and never takes it as an argument:

```
tools/first-admin
```

If no admin can sign in (an admin locked out by someone failing codes against their address, or the last admin gone), the break-glass makes a listed address an admin again and clears its lockout, and is audited:

```
tools/recover-admin
```

If someone is locked out, or has run out of sends, by someone else's attempts against their address, clear it without changing their role. Use this, not the break-glass, for anyone who shouldn't become an admin. It clears the address's lockout, live code and send limits, and is audited as `clear-lock`. For an address that isn't listed it does the same and records only an HMAC:

```
tools/clear-lock
```

They need `server/` installed (`cd server && pnpm install --frozen-lockfile`, which needs read access to `auth-kit`) and `terraform -chdir=infra output users_table` to work.

### Personal data

The site's personal data is the list (email address, admin flag, who added them and when), the audit log (time, actor's address, action, target's address; sign-ins, wrong codes and lockouts too, and an attempt by an unlisted address is recorded as an HMAC, never the address), the sign-in emails SES sends, and the API's logs, which hold opaque ids and no address. No IP address is stored with any of it: CloudFront keeps no access log, and WAF only its sampled requests, which AWS holds for three hours. All of it is stored in af-south-1; a request passes, encrypted, through the CloudFront edge nearest the person, which can be outside South Africa and caches only the site's files, never `/api/*`. The privacy notice at `privacy/`, linked from the app bar of every page, says so: its text is `static/data/privacy.md` in the private repo, which `pnpm data:private` copies in (`docs/architecture.md` § Privacy notice). Before the real deploy, fill its placeholders and get the client's agreement with the private repo's `docs/hosting-consent.md` (H12). Its periods are pinned by the private repo's `tests/unit/privacy.test.ts` to `auth-kit`, `server/` and `infra/`, so a change here that the notice doesn't follow fails `pnpm test:private`.

**Retention.** Audit rows carry a TTL of 24 months (`auth-kit`'s `AUDIT_RETENTION_MONTHS`), and DynamoDB deletes them within days of it, so the notice says "about 24 months". Codes, throttles and revocations expire within days. Point-in-time recovery keeps deleted items restorable for 35 days. The site bucket keeps replaced and deleted file versions for 30 days. The API's logs are kept 90 days (`api_log_retention_days`), and so are the pipeline's (`dws_log_retention_days`), which hold no personal data. An address whose code bounced or was marked as spam stays on SES's account-level suppression list until the operator removes it.

**Deletion on request.** The operator erases the address everywhere: the user, if still listed (refused if they are the last admin), their code and throttle, and the address in every audit row and in other users' "added by", replaced by `erased:<hmac>`:

```
tools/erase-user
```

Then take the address off SES's account-level suppression list if it is on it (`aws sesv2 delete-suppressed-destination --email-address <address> --region af-south-1 --profile ewr-compliance`, typed by the operator), and record the erasure. It is complete 35 days later, when PITR no longer holds the deleted items. Reply to the person with what was done.

**Access to their data.** The Users page and `GET /api/audit` (admins) show what is held about a listed address. Send it to the person, not into a file or a ticket.

## Build

Needs Node 24 and pnpm 10.

```
pnpm install --frozen-lockfile
pnpm data:private
pnpm build
```

Use `pnpm data:sample` in place of `pnpm data:private` for a trial build. With neither, the build still succeeds but the app cannot start, because it needs `data/index.json`.

Deploy with `tools/deploy.sh sample` (the synthetic sample, to test the site and its gate) or `tools/deploy.sh real` (the real data, from the private repo beside this one or `EWR_PRIVATE_DIR`), from the operator's workstation and never from CI. It builds a clean, temporary worktree of freshly fetched `origin/main`, never the working tree, with no base map and no `BASE_PATH`. Before uploading, `tools/deploy-check.mjs` refuses a build whose data does not match the mode, with no `data/index.json`, with a `tiles/` folder or with a `_headers` file, and warns when there is no `signin/index.html`. A `real` deploy asks for the project name to be typed before uploading, unless given `--yes`.

The upload is `aws s3 sync` with the operator's SSO profile (`ewr-compliance`, or `AWS_PROFILE`), to the bucket and distribution from `terraform output` in `infra/` or from `EWR_SITE_BUCKET` and `EWR_DISTRIBUTION_ID`. It goes in two cache passes: `_app/immutable/` as `public, max-age=31536000, immutable`, then everything else, with `--delete`, as `private, no-cache`. `.mjs` files go up as `text/javascript`. The previous build's chunks are deleted only after the pages that named them are replaced, then the whole distribution is invalidated. The script never reads or prints a credential. `--dry-run` builds and checks, prints the commands, and stops; it needs no AWS login when both environment variables are set. After a deploy, run the checks in `infra/README.md` § After a deploy.

Elsewhere, upload the contents of `build/`, not the folder itself. That is about 30 MB with the real data and the rivers, or about 295 MB with the base map.

| Build setting | Default | Purpose |
|---|---|---|
| `BASE_PATH` | empty | The sub-path, such as `/ewr`, with a leading slash and no trailing one. Must be in the shell's environment: a `.env` file does not reach it. |
| `VITE_TILES_URL` | empty | The base map's `.pmtiles`: a path beside the app, taken from the app's root on every page (`tileUrl`), or a full `https` URL. Empty gives a plain background. |
| `VITE_TILES_GLYPHS_URL` | empty | Label fonts, with `{fontstack}` and `{range}` left in, a path or URL as for `VITE_TILES_URL`. Empty leaves the base map unlabelled. |

These are read at build time, so changing one means building again. `.env.local` is read for the two `VITE_` settings, which is how `tools/fetch-tiles.sh` turns the base map on. No setting holds a secret, and everything built is readable by anyone who can load the site.

## At a domain root, or under a sub-path

For a domain root, the build above is complete.

For a sub-path, set `BASE_PATH`:

```
BASE_PATH=/ewr pnpm build
```

The pages work out their base from their own address, so a plain build also works under a sub-path. Only `404.html` cannot, because a host serves it from any depth: without `BASE_PATH` a mistyped address under a sub-path is a blank page. A build with `BASE_PATH=/ewr` works only under `/ewr/`.

Each route is a folder, `nodes/index.html` and `notes/index.html`. The host must do two things that nearly all do by default:

- Send `/nodes` to `/nodes/` with a redirect. A rewrite that serves the page at `/nodes` breaks under a sub-path, because the page's relative paths then point one level too high.
- Serve `index.html` for a folder, not just at the top. An S3 bucket behind CloudFront does not do this until it uses the bucket's website endpoint or a small rewrite function.

Set `404.html` as the not found page if the host asks. Do not turn on a "single page app" rewrite that answers every address with `index.html`: every route already has its own file.

On GitHub Pages published from a branch, add `.nojekyll` to the upload, or Jekyll drops `_app/`.

## Headers

None are required. These matter when the host allows them:

| Files | Header | Why |
|---|---|---|
| `*.mjs` | `Content-Type: text/javascript` | **Required in effect.** The map's worker is a module, and the browser refuses it under a type that is not JavaScript: the map's layers do not load, and the console logs "Worker failed to load". `application/javascript` also works. Check this on any host that sets types from its own list. |
| `*.json`, `*.js`, `*.css`, `*.html` | gzip or brotli | The real `data/` is 19 MB, and 3.6 MB gzipped. |
| `_app/immutable/*` | `Cache-Control: public, max-age=31536000, immutable` | The names carry a hash. |
| Every page, `data/*` | `Cache-Control: private, no-cache` | These keep their names between builds. `private` because they sit behind the sign-in and the data may be real, so no shared cache should keep a copy. |
| Everything | `X-Content-Type-Options: nosniff` | |
| Everything | `Content-Security-Policy: frame-ancestors 'none'` | A meta tag cannot carry this one. A second policy from the host adds to the one in the page, so it can only tighten it. |
| Everything | `Referrer-Policy: strict-origin-when-cross-origin` | Other sites get the site's origin and never a path. Stricter gains nothing: every request to another site is a CORS request, which sends the origin as `Origin` whatever this says. |

A page is a folder's address, such as `/nodes/`, so a rule for `*.html` alone misses every page but `404.html`.

On AWS, the CloudFront response-headers policy (`infra/security_headers.tf`) sets the last three rows, with HSTS, on every response; `tools/deploy.sh` sets each object's `Cache-Control` and the `.mjs` type as it uploads; and CloudFront compresses text (CachingOptimized). `infra/tests/security_headers.tftest.hcl` pins the policy. The API's answers get their own policy (`default-src 'none'`, no referrer) and `Cache-Control: no-store` from the API itself, and `/api/*` is never cached at the edge. The sign-in page carries its own CSP meta tag (`script-src 'self'`, `connect-src 'self'`). On any other host, take the table as the list to set.

CloudFront caches files under `/signin/*` and the signed paths only by URL (CachingOptimized), and checks the signed cookies on every request, cached or not, so a cached file never reaches someone without them.

Serve the site over `https`. The browser's Copy needs a secure context.

## Content security policy

Every built page carries the policy as a meta tag, with the hash of its own start-up script, so no host has to set it. The tag is built by `vite.config.ts`, and the dev server has none. Any violation fails the Playwright suite, as a console error.

| Directive | Value | Why |
|---|---|---|
| `default-src` | `'none'` | |
| `script-src` | `'self'` and a hash | The hash is SvelteKit's start-up script. |
| `style-src` | `'self' 'unsafe-inline'` | Svelte templates and MapLibre set style attributes, and the browser drops them without this. |
| `img-src` | `'self' data:` | MapLibre's control icons. |
| `worker-src` | `'self'` | The MapLibre worker. |
| `connect-src` | `'self'` and the origins below | See below. |
| `base-uri`, `form-action`, `object-src` | `'self'`, `'none'`, `'none'` | |

The site's own origin covers `data/`, `geo/`, the DWS store under `dws/`, and `tiles/` when the base map is uploaded. The browser does not call DWS: the store is ours, served from the site (`docs/architecture.md` § DWS store). The origins it needs beyond the site, and all that `connect-src` allows, are:

| Origin | For |
|---|---|
| `https://services3.arcgis.com` | DWS quaternary catchments and basin boundaries |
| `https://services8.arcgis.com` | Flow gauges |
| The host of `VITE_TILES_URL` or `VITE_TILES_GLYPHS_URL`, when either is a full `https` URL elsewhere | Base map and label fonts |

`src/csp.ts` builds this list at build time, reading the two tile settings from the environment or `.env` files, and `src/csp.test.ts` pins it. So a script that got into the page could not send a loaded flow file to another site, and `hosting.spec.ts` checks that the built page refuses one. A new origin the app needs goes in `src/csp.ts`, or the browser refuses it and the Playwright suite fails on the console error.

## Live DWS boundaries and gauges

The host needs nothing for these. Each browser reads them directly from the ArcGIS services, and they must not be copied onto the host: see `NOTICE.md`. The services answered with `Access-Control-Allow-Origin: *` when checked on 2026-10-30, so they work from any origin today. That is their owners' setting and may change, and a network that blocks `arcgis.com` loses the layers. If they fail, the map says so and the rest of the app works.

## Base map

`tools/fetch-tiles.sh` fills `static/tiles/`, 251 MB of `.pmtiles` for South Africa and the label fonts, and `pnpm build` copies it into `build/tiles/`. Check the host's limit on one file. To keep the file elsewhere, set `VITE_TILES_URL` and `VITE_TILES_GLYPHS_URL` to full `https` URLs.

`tools/deploy.sh` builds without it for now (Q4 in the private plan: S3 answers range requests, so it could come back). To have one meanwhile, host the `.pmtiles` elsewhere and set `VITE_TILES_URL`.

The host of the `.pmtiles`, here or elsewhere, must:

- Answer a `Range` request with `206`. A `200` with the whole file counts as a failure.
- Not compress the `.pmtiles`.
- If it is another origin, send `Access-Control-Allow-Origin` for the site's origin, and `Access-Control-Expose-Headers: ETag`. The map loads without the second, but cannot then notice the file changing.

If tiles are missing, refused or not range-capable, the map draws on the plain background and its legend reads "Base map not available". With neither setting, no base map is offered.

## Check a build

```
BASE_PATH=/ewr pnpm build && BASE_PATH=/ewr pnpm preview
```

Then open http://localhost:7790/ewr/. `pnpm test:e2e` does this on a stricter server through `e2e/tests/hosting.spec.ts`, against the sample. After uploading, load `nodes/` directly, press reload, confirm the map shows nodes, and confirm the browser console is clean.

## Deploy readiness

The operator's steps from nothing to live, in the order they must run. The numbers are the private plan's (issue 12); each step's commands, one at a time, are in `infra/README.md` § Operator steps. Every step is the operator's: a session never runs anything that touches AWS, a credential or a key. Tick each in the plan as it is done.

| Step | What | Flags in `prod.tfvars` afterwards |
|---|---|---|
| H0 | Read access to `auth-kit`: the fine-grained token as the Actions and Dependabot secret `AUTH_KIT_READ_TOKEN`. Needed before CI can build `server/` and before H9 | all off |
| H1 | `infra-secrets/ewr-compliance/bootstrap.tfvars`, committed and pushed | — |
| H2 | `aws sso login` as `mgmt` and `dns-parent` | — |
| H3 | `new-project-account.sh ewr-compliance`, `--plan` first (Runbook A) | — |
| H4 | Enable af-south-1 for the account; wait for `ENABLED` | — |
| H5 | Identity Center assignment, the `ewr-compliance` SSO profile, IAM access to billing | — |
| H6 | `backend.config`, `prod.tfvars`, `init`, `plan`, `apply` (P1). Confirm both SNS subscription emails; both budgets listed | all off |
| H7 | The CloudFront key pair: public key in `cloudfront_public_keys`, apply, private key into its secret from the file. `tools/deploy.sh sample`, then § After a deploy in `infra/README.md`; note whether the edge function or the signature check runs first. Shred the key file | `site_enabled = true` |
| H8 | Apply the sign-in, request SES production access, wait for DKIM `SUCCESS` | `auth_enabled = true` |
| H10 | `production` environment reviewer and tag rules, `AWS_DEPLOY_ROLE_ARN`, `AWS_REGION`, `API_FUNCTION_NAME`; release `api@X.Y.Z` and approve it. `api/me` answers 401 JSON, not 503 | unchanged |
| H9 | `tools/first-admin` with your address; sign in; add a second admin on the Users page | unchanged |
| H11 | Apply the store; `DWS_FUNCTION_NAME`, release `pipeline@X.Y.Z`; `tools/dws-stations.sh`; one pull by hand (Q1's test request); the backfill; then the daily schedule. The DWS API key from a file, when it exists | `dws_enabled = true`, then `dws_schedule_enabled = true` once the backfill is done |
| H12 | Fill the privacy notice's placeholders (private repo `static/data/privacy.md`) and send the client `docs/hosting-consent.md`; keep the reply in the plan | unchanged |
| H13 | Once the client agrees: `tools/deploy.sh real`, then every check below | unchanged |
| H14 | Registry rows in `project-mgmt` (`vendor-accounts`, `architecture`) and the `templates` `estate-map` | unchanged |

H10 comes before H9 because the first admin signs in through the deployed API. `deploy_lambda_functions` stays empty: the API and the pipeline are granted by their own flags. `cost_anomaly_threshold_usd` is optional, at any point after H6.

### Go-live checks

After H13, with `<domain>` the site's domain. Say what each showed in the plan.

- **Signed out, everything is closed.** From a private window, `https://<domain>/`, `/nodes/` and `/data/index.json` each end on the sign-in page with `?next=` naming the path. `curl -sI https://<domain>/data/index.json` gives `302` to `/signin/?next=%2Fdata%2Findex.json`, and `curl -s -H 'X-Requested-With: XMLHttpRequest' https://<domain>/data/index.json` gives the `401` JSON. (If the H7 note says CloudFront checks the signature first, both are a `403` serving the sign-in page instead: still closed.)
- **The DWS store is signed too.** The same two `curl`s on `https://<domain>/dws/index.json` give the same answers; signed in, the app's Data source offers "DWS (kept current)" at a linked node, with its `fetchedAt`.
- **An address off the list gets nothing.** It gets the same "a code is on its way" as a listed one, takes as long, and no email arrives. An audit row records it only as an HMAC (`GET /api/audit`, as an admin).
- **Signing in and out.** Signing in opens the page asked for. Sign out, then the browser's back button, gets the sign-in page.
- **Removing a user.** A user removed on the Users page gets `401` from `/api/me` at once (their next click in the app sends them to sign in), and their file cookies stop working within 15 minutes.
- **A lapsed file cookie.** A signed-in tab left open past 15 minutes, with the laptop asleep, keeps working when it comes back: the app renews the cookies, or sends the person to sign in, never a page that fails to start.
- **Past CloudFront.** A request straight to the API's Function URL (Lambda console) gets `404`: the origin secret is checked.
- **Headers.** `curl -sI https://<domain>/signin/` shows `strict-transport-security`, `x-content-type-options: nosniff`, `content-security-policy: frame-ancestors 'none'` and `referrer-policy: strict-origin-when-cross-origin`; a signed `.mjs` under `_app/immutable/workers/` is `text/javascript` with the immutable `Cache-Control` (`infra/README.md` § After a deploy). The browser console is clean on `/`, a WMA's map and `/nodes/`.
- **Mail.** `DkimAttributes.Status` reads `SUCCESS` and `ProductionAccessEnabled` is `true` (H8's commands). The code's email arrives from `no-reply@<domain>` and passes DKIM in the receiving mailbox's headers.
- **Alarms reach the operator.** Every subscription on both topics (`terraform -chdir=infra output alerts_topic_arns`) is confirmed, none `PendingConfirmation`: `aws sns list-subscriptions-by-topic --topic-arn <arn> --region <its region> --profile ewr-compliance --query 'Subscriptions[].SubscriptionArn'`. The alarms in CloudWatch, af-south-1 and us-east-1, are `OK` or `INSUFFICIENT_DATA`, none `ALARM`.
- **Budgets.** Both budgets are listed (H6's command), and Cost Anomaly Detection is on if `cost_anomaly_threshold_usd` is set.
- **The privacy notice.** `/privacy/` shows the real notice with no `[` placeholder left, and its date.
- **The real data.** The map shows the nodes, a node's comparisons draw, and the build `tools/deploy.sh real` uploaded is `origin/main`'s (it prints the commit).
