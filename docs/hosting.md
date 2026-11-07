# Hosting

The app is a folder of static files, and `server/` is the sign-in API in front of it. `tools/deploy.sh` deploys the files to the AWS site below; CI deploys the API (`.github/workflows/deploy-lambdas.yml`). Nothing is live yet: the private hosting plan's phases P4 to P6 follow.

## AWS, as built so far (P1 to P3)

`infra/` holds the Terraform; `infra/README.md` has the operator's steps, one command at a time, and what each file makes. Nothing is applied yet.

- **Account and region.** The `ewr-compliance` sub-account, made by the estate bootstrap. The workload is in af-south-1, and `aws_region` refuses anything else unless `data_outside_south_africa` is set. Terraform state is in the bootstrap's us-east-1 bucket, named in the gitignored `infra/backend.config`; the values are in `infra-secrets`.
- **Alerts and cost.** Two SNS topics mail the operator; monthly and daily budgets; Cost Anomaly Detection once turned on.
- **Deploy role.** The bootstrap's OIDC role, for the `production` environment only. It may update the code of the API (once `auth_enabled`) and of any Lambda in `deploy_lambda_functions`, and nothing else. It can never write the site bucket: the site and its data go up only from the workstation.
- **The site** (`site_enabled`). A private, versioned S3 bucket read by CloudFront through OAC. Every path needs CloudFront signed cookies (the default behaviour trusts one key group) except `/signin/*`. The viewer-request function sends a request without a live `CloudFront-Policy` cookie to `/signin/?next=…`, or answers `401` JSON when it carries `X-Requested-With`, and serves a folder path its `index.html` (with a `301` to add the slash). CloudFront's own `403`, for a cookie whose signature fails, shows the sign-in page. The private key that signs the cookies is in a Secrets Manager secret Terraform creates empty; the operator puts it in from a file. `/api/*` goes to the API (§ Access control). WAF limits each address on every path and, more tightly, on `/api/auth/*`. Price class All, for South African edges.
- **Headers.** A response-headers policy sets what `static/_headers` set on Pages, plus HSTS, and `infra/tests/security_headers.tftest.hcl` pins it. `Cache-Control` is set per object by `tools/deploy.sh` instead: § Headers.
- **Sign-in** (`auth_enabled`, `infra/auth.tf`). The API Lambda, the user table and SES: § Access control.

## The data is the decision

A build publishes whatever is in `static/data`. This repo holds only the synthetic sample, which is invented, so a build of it shows made-up nodes and numbers and is no use for real compliance work.

A real deployment must run `pnpm data:private` before `pnpm build`, on a machine that has the private repo. **That publishes the real data.** Every file in `static/data` is copied into `build/data/` and can be downloaded by anyone who can load the site, whatever the app shows. Those files are not under the MIT licence and all rights remain with their owners: read `NOTICE.md`. So hosting real data needs the operator's decision first, and if the site must be private, the host needs its own access control. The private repository being private does not make the host private.

CI builds the sample only and has no access to the private repo, so a real build cannot come from it as things stand.

## Access control

Nobody reaches a file of the site, `data/` included, without CloudFront signed cookies, and only the API (`server/`, on the private package `auth-kit`) issues them: to an address on the site's list, after a 6-digit code sent to it. How it works: `docs/architecture.md` § Users and access. What Terraform makes: `infra/auth.tf`.

- **The list** is one DynamoDB table in af-south-1 (`ewr-compliance-users`): users, the admin count, codes and throttles (keyed by an HMAC of the address, so a stranger's address is never stored), revoked sessions, and the audit log. Admins keep it on the Users page; every change is one transaction with its audit row, and the site always keeps an admin.
- **Codes** are valid 10 minutes, spent after 3 wrong tries, at most one a minute and 10 a day an address; 5 wrong codes in a row lock the address for a while (`auth.locked` alarms). Nothing says whether an address is listed, by answer or by timing.
- **Sessions** are an HttpOnly `__Host-` cookie for 7 days. The files' cookies last 15 minutes and the app renews them while it is open. Every API call re-reads the user: a removed user is refused by the API at once, and the files close to them within 15 minutes (Q3 in the plan accepts that).
- **Mail** goes from `no-reply@<domain>` through SES in af-south-1, DKIM-signed, over TLS only.
- **Keys.** The code key, the session key and the CloudFront origin secret are Terraform `random_password`s in the API's runtime secret (state holds them, encrypted, as the estate standard allows); the CloudFront private key is the operator's, put in by hand (H7). None is in the Lambda's environment, which the CI deploy role can read.

The cookies are strictly necessary to reach the site, so they need no consent banner. The app itself sets none.

### First admin, and recovery

The operator adds the first admin once, with their own AWS profile (H9 in `infra/README.md`); admins add everyone else on the Users page. Each tool asks for the address and never takes it as an argument:

```
tools/first-admin
```

If no admin can sign in (an admin locked out by someone failing codes against their address, or the last admin gone), the break-glass makes a listed address an admin again and clears its lockout, and is audited:

```
tools/recover-admin
```

They need `server/` installed (`cd server && pnpm install --frozen-lockfile`, which needs read access to `auth-kit`) and `terraform -chdir=infra output users_table` to work.

### Before going live

- From a browser that is not signed in, `data/index.json` gets the sign-in page (or 401 JSON with `X-Requested-With`), and so does `/nodes/`.
- An address not on the list gets the same "a code is on its way" and no email.
- Signing in opens the page asked for; Sign out, then the browser's back button, gets the sign-in page.
- A user removed on the Users page gets 401 from `/api/me` at once.
- A request straight to the Function URL (shown on the Lambda console), past CloudFront, gets 404: the origin secret is checked.
- SES is out of the sandbox and the identity's DKIM reads SUCCESS (H8).

### Personal data

The site's personal data is the list (email address, admin flag, who added them and when), the audit log (time, actor's address, action, target's address; a failed sign-in by an unlisted address is recorded as an HMAC, never the address), the sign-in emails SES sends, and the API's logs, which hold opaque ids and no address. The privacy notice at `privacy/`, linked from the app bar of every page, says so: its text is `static/data/privacy.md` in the private repo, which `pnpm data:private` copies in (`docs/architecture.md` § Privacy notice). Before the real deploy, fill its placeholders and get the client's agreement with the private repo's `docs/hosting-consent.md` (P6).

**Retention.** Audit rows carry a TTL of 24 months (`auth-kit`'s `AUDIT_RETENTION_MONTHS`), and DynamoDB deletes them within days of it, so the notice says "about 24 months". Codes, throttles and revocations expire within days. Point-in-time recovery keeps deleted items restorable for 35 days. The site bucket keeps replaced and deleted file versions for 30 days. The API's logs are kept 90 days (`api_log_retention_days`).

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
