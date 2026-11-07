# Hosting

The app is a folder of static files. Nothing here deploys it, and no host has been chosen.

## The data is the decision

A build publishes whatever is in `static/data`. This repo holds only the synthetic sample, which is invented, so a build of it shows made-up nodes and numbers and is no use for real compliance work.

A real deployment must run `pnpm data:private` before `pnpm build`, on a machine that has the private repo. **That publishes the real data.** Every file in `static/data` is copied into `build/data/` and can be downloaded by anyone who can load the site, whatever the app shows. Those files are not under the MIT licence and all rights remain with their owners: read `NOTICE.md`. So hosting real data needs the operator's decision first, and if the site must be private, the host needs its own access control. The private repository being private does not make the host private.

CI builds the sample only and has no access to the private repo, so a real build cannot come from it as things stand.

## Access control

The decision: a site with the real data is open only to people on an allow-list of email addresses. Nobody else can load any of its files.

The access is checked by the host, in front of the files, and not by the app:

- A login in the app would not protect anything. Every file in `data/` can be fetched directly, so the check has to cover each request, `data/` included, and only the host sees each request.
- The app has nothing a person owns on a server. Choices are kept in the browser's `localStorage`, and a loaded flow file stays in the browser. An account would only decide who can open the site.
- Accounts in the app need a server, for passwords and sessions, and the app has none (CLAUDE.md, hard rule 1).

What the host needs:

- An access gateway in front of the whole site, with a policy that allows the listed email addresses and refuses everyone else.
- Sign-in with a one-time code sent to the address, so nobody has a password to keep and none is stored. Signing in through an organisation's Microsoft or Google account can come later, through the same gateway.
- The list kept by the host's operator, in the gateway's settings. It names people, so it is not kept in this repo.
- A session of a working day or so, after which the person signs in again.

Cloudflare Access does all of this, free for up to 50 people, with no change to the app. On AWS, CloudFront with a Lambda@Edge check against Cognito does the same, with more to maintain. Any host whose gateway checks every request is fine. A password page that only hides `index.html` is not.

The gateway is on the site's own address, so the content security policy is unchanged. It sets a sign-in cookie of its own. That cookie is strictly necessary to reach the site, so it needs no consent banner. The app itself still sets no cookie.

Before going live, check from a browser that is not signed in that `data/index.json` gets the sign-in page and not the data, and that someone off the list cannot get past the sign-in.

Accounts in the app, kept on a server, would be needed only for features the brief does not ask for: choices that follow a person between machines, a record of who did what, or different rights for different people. Any of them means adding a server, and changing hard rule 1 first.

## Build

Needs Node 24 and pnpm 10.

```
pnpm install --frozen-lockfile
pnpm data:private
pnpm build
```

Use `pnpm data:sample` in place of `pnpm data:private` for a trial build. With neither, the build still succeeds but the app cannot start, because it needs `data/index.json`.

Upload the contents of `build/`, not the folder itself. That is about 30 MB with the real data and the rivers, or about 295 MB with the base map.

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
| `*.mjs` | `Content-Type: text/javascript` | **Required in effect.** The map's worker is a module, and the browser refuses it under any other type: the map's layers do not load, and the console logs "Worker failed to load". Check this on any host that sets types from its own list. |
| `*.json`, `*.js`, `*.css`, `*.html` | gzip or brotli | The real `data/` is 19 MB, and 3.6 MB gzipped. |
| `_app/immutable/*` | `Cache-Control: public, max-age=31536000, immutable` | The names carry a hash. |
| `*.html`, `data/*` | `Cache-Control: no-cache` | These keep their names between builds. |
| Everything | `X-Content-Type-Options: nosniff` | |
| Everything | `Content-Security-Policy: frame-ancestors 'none'` | A meta tag cannot carry this one. A second policy from the host adds to the one in the page, so it can only tighten it. |

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
