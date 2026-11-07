# Hosting

The app is a folder of static files, plus `functions/`, the access check that Cloudflare Pages runs in front of them. `tools/deploy.sh` deploys it there: § Build.

## The data is the decision

A build publishes whatever is in `static/data`. This repo holds only the synthetic sample, which is invented, so a build of it shows made-up nodes and numbers and is no use for real compliance work.

A real deployment must run `pnpm data:private` before `pnpm build`, on a machine that has the private repo. **That publishes the real data.** Every file in `static/data` is copied into `build/data/` and can be downloaded by anyone who can load the site, whatever the app shows. Those files are not under the MIT licence and all rights remain with their owners: read `NOTICE.md`. So hosting real data needs the operator's decision first, and if the site must be private, the host needs its own access control. The private repository being private does not make the host private.

CI builds the sample only and has no access to the private repo, so a real build cannot come from it as things stand.

## Access control

The decision: only people on the site's list of users can load any of its files. The list is kept by the site's admins, in the app. The operator adds the first admin once; after that, admins add and remove users and make other admins. Design: `docs/architecture.md` § Users and access.

The host is Cloudflare Pages, because the check runs there, in front of every file:

- **Cloudflare Access** signs people in with a one-time code sent to their email address, so nobody has a password and none is stored. Its policy lets in any address that completes the code. It proves who someone is, not whether they may come in.
- **`functions/_middleware.ts`** runs before every request, `data/` included. It verifies the Access token and looks the address up in the list. Anyone not on it gets a page saying so, and an admin removing someone takes effect on that person's next request, not when their sign-in expires.
- **Cloudflare D1** holds the list and a log of every change, with who made it. It names people, so it is never copied into a repo.

Settings the Pages project needs (dashboard, Settings):

| Setting | Value |
|---|---|
| Variable `ACCESS_TEAM_DOMAIN` | The Zero Trust team domain, `<team>.cloudflareaccess.com` |
| Variable `ACCESS_AUD` | The Application Audience (AUD) tags of the site's two Access applications, the site and its deployment previews, separated by a comma |
| D1 binding `USERS_DB` | The user database, with `migrations/0001_users.sql` applied |
| Functions failure mode | **Fail closed.** Fail open serves the files without the check once the free daily limit is used up |

Set the variables and the binding for both of the project's environments, Production and Preview: Pages keeps them apart, and a preview without them refuses everyone. Without either variable, or the binding, every request is refused with "not set up". If Access's keys cannot be fetched, requests are refused with "Sign-in unavailable" until they can. The first admin, once, by the operator:

```
pnpm wrangler d1 execute ewr-compliance-users --remote --command "INSERT INTO users (email, admin, added_by, added_at) VALUES ('<address>', 1, 'operator', datetime('now'))"
```

The address in lowercase: the table refuses any other, because a mixed-case address would never match a sign-in. A typo there locks nobody in or out for good: run it again with the right address.

The sign-in cookie is Access's and strictly necessary to reach the site, so it needs no consent banner. The app itself still sets no cookie. The list is personal data the operator keeps for the client: email addresses, who added whom and when.

Before going live, check from a browser that is not signed in that `data/index.json` gets the sign-in page, that an address not on the list gets "Not on the list" after signing in, for `data/index.json` as well as the home page, and that removing a user shuts them out on their next request.

### Cost

At this scale it is free: checked on 2026-11-06 against Cloudflare's pricing pages.

| Part | Free allowance | This site |
|---|---|---|
| Pages | Static files free and unlimited, 500 builds a month, 20,000 files of up to 25 MiB | About 1,000 files and 30 MB |
| Pages Functions | 100,000 requests a day, 10 ms CPU each. Every file is a request, because the middleware runs on all of them | About 30 to 60 requests a page load: 20 people loading it 10 times a day is about 12,000 |
| D1 | 5 million rows read and 100,000 written a day, 5 GB | One row read a request |
| Zero Trust (Access) | Up to 50 users. A card is needed to activate the Free plan, and is not charged | A user takes a seat when they sign in, on the list or not. Seats can be set to expire |

The first cost, if one ever comes, is Workers Paid at US$5 a month for the account, which lifts the daily request limit to 10 million a month. More than 50 people signing in moves Zero Trust to US$7 a user a month. A custom domain needs its zone on Cloudflare, free on the Free plan, plus the domain's own registration.

Because Access lets in any address that completes the code, someone off the list can use up a seat by signing in. They see only "Not on the list". If seats ever run short, shorten the seat expiry, or keep the Access policy in step with the list.

## Build

Needs Node 24 and pnpm 10.

```
pnpm install --frozen-lockfile
pnpm data:private
pnpm build
```

Use `pnpm data:sample` in place of `pnpm data:private` for a trial build. With neither, the build still succeeds but the app cannot start, because it needs `data/index.json`.

On Cloudflare Pages, deploy with `tools/deploy.sh sample` (the synthetic sample, to test the site and its gate) or `tools/deploy.sh real` (the real data, from the private repo beside this one or `EWR_PRIVATE_DIR`), from the operator's workstation and never from CI. It uses wrangler's own login, `pnpm wrangler login`, and never handles a token. It builds a clean, temporary worktree of freshly fetched `origin/main`, never the working tree, with no base map and no `BASE_PATH`. Before uploading, `tools/deploy-check.mjs` refuses a build with a file over 25 MiB, more than 20,000 files, data that does not match the mode, a `tiles/` folder, a `_worker.js` or `_routes.json`, or no `functions/_middleware.ts`, and compiles `functions/` to check that `_middleware` runs on every path. It warns when `_headers` is missing. `--dry-run` stops there and says what would go up; it needs no login. A `real` deploy asks for the project name to be typed before uploading, unless given `--yes`.

The script runs `pnpm wrangler pages deploy build --project-name ewr-compliance --branch main` from the worktree's root, which is how `functions/` goes up with the files. **A deploy without `functions/` has no list check, and anyone who completes Access's code gets in.** The script fails if wrangler does not report uploading the Functions bundle. After each deploy, check that its Functions tab lists `_middleware`, and run the checks at the end of § Access control.

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

On Cloudflare Pages, `static/_headers` sets all but the first two rows, which Pages does itself: it serves `.mjs` as JavaScript and compresses text. `pnpm build` copies it to `build/_headers`, and `src/headers.test.ts` pins its rules. Pages applies it to the files `functions/_middleware.ts` passes on with `ctx.next()`, but not to a response a Function makes itself, such as the sign-in refusal or `api/`. Its paths are from the domain root, so a build with `BASE_PATH` needs them prefixed. Elsewhere, take the file as the list to set.

Pages keeps every uploaded file in its own cache until the next deploy, behind the middleware, which still checks each request. A cache rule on the domain sits in front of the middleware, and could serve a page or data file to someone it never checked: add none. Cloudflare does not cache HTML or JSON unless a rule tells it to, and does not store a `private` response.

Serve the site over `https`. The browser's Copy needs a secure context. A browser refuses an `http` API from an `https` page whatever the policy says.

## Content security policy

Every built page carries the policy as a meta tag, with the hash of its own start-up script, so no host has to set it. The tag is built by `vite.config.ts`, and the dev server has none. Any violation fails the Playwright suite, as a console error.

| Directive | Value | Why |
|---|---|---|
| `default-src` | `'none'` | |
| `script-src` | `'self'` and a hash | The hash is SvelteKit's start-up script. |
| `style-src` | `'self' 'unsafe-inline'` | Svelte templates and MapLibre set style attributes, and the browser drops them without this. |
| `img-src` | `'self' data:` | MapLibre's control icons. |
| `worker-src` | `'self'` | The MapLibre worker. |
| `connect-src` | `'self' https: http:` | See below. |
| `base-uri`, `form-action`, `object-src` | `'self'`, `'none'`, `'none'` | |

The site's own origin covers `data/`, `geo/`, and `tiles/` when the base map is uploaded. The origins the browser needs beyond it are:

| Origin | For |
|---|---|
| `https://services3.arcgis.com` | DWS quaternary catchments and basin boundaries |
| `https://services8.arcgis.com` | Flow gauges |
| The host of `VITE_TILES_URL`, if it is elsewhere | Base map and label fonts |
| The addresses typed under Data source > DWS API, on either comparison | The DWS APIs |

The last one is why `connect-src` is two schemes and not this list. A user types the address, so no build can know it, and a list would refuse it. The form accepts `http` as well as `https`, so the policy does too. The cost is that the policy does not stop a script that has got into the page from sending data elsewhere: `script-src` is what guards against that getting in.

Once the DWS API has a fixed address, change `connect-src` in `vite.config.ts` to the list above, and test the address box against it: anything else typed there will then be refused, and `apiInputProblem` in `src/lib/ewr/importFlow.ts` should say so.

## Live DWS boundaries and gauges

The host needs nothing for these. Each browser reads them directly from the ArcGIS services, and they must not be copied onto the host: see `NOTICE.md`. The services answered with `Access-Control-Allow-Origin: *` when checked on 2026-10-30, so they work from any origin today. That is their owners' setting and may change, and a network that blocks `arcgis.com` loses the layers. If they fail, the map says so and the rest of the app works.

## Base map

`tools/fetch-tiles.sh` fills `static/tiles/`, 251 MB of `.pmtiles` for South Africa and the label fonts, and `pnpm build` copies it into `build/tiles/`. Check the host's limit on one file. To keep the file elsewhere, set `VITE_TILES_URL` and `VITE_TILES_GLYPHS_URL` to full `https` URLs.

On Cloudflare Pages the base map cannot be beside the app: the file is far over Pages' 25 MiB limit, and Pages answers a range request with `200`. `tools/deploy.sh` builds without it. To have one there, host the `.pmtiles` elsewhere and set `VITE_TILES_URL`.

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
