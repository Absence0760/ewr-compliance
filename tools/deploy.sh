#!/usr/bin/env bash
# Deploys the site to Cloudflare Pages, project ewr-compliance, production branch main, from this
# workstation. Never from CI: CI has no access to the real data, and must not have.
#
#   tools/deploy.sh sample [--dry-run]          the synthetic sample, to test the site and its gate
#   tools/deploy.sh real   [--dry-run] [--yes]  the real data, from ../ewr-compliance-private or EWR_PRIVATE_DIR
#
# It builds from a clean, temporary git worktree of freshly fetched origin/main, never from this
# working tree, which may hold uncommitted work or the wrong static/data. The build has no base map
# and no BASE_PATH. tools/deploy-check.mjs then refuses a build that is too big for Pages, holds the
# wrong data, carries tiles/, or whose functions would not put _middleware in front of every path.
#
# --dry-run does all of that and stops before the upload, saying what would go up. It needs no
# Cloudflare login. A real upload uses wrangler's own login (`pnpm wrangler login`, by the operator):
# this script never reads, prints or passes a token.
set -euo pipefail

PROJECT=ewr-compliance
BRANCH=main

usage() {
	echo "Usage: tools/deploy.sh sample|real [--dry-run] [--yes]" >&2
	exit 2
}

mode=
dry_run=0
yes=0
for arg in "$@"; do
	case $arg in
		sample | real) [ -z "$mode" ] || usage; mode=$arg ;;
		--dry-run) dry_run=1 ;;
		--yes) yes=1 ;;
		-h | --help) usage ;;
		*) echo "Unknown argument: $arg" >&2; usage ;;
	esac
done
[ -n "$mode" ] || usage

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/.." && pwd)
check="$here/deploy-check.mjs"
# Wrangler's anonymous usage metrics stay off for every call here.
export WRANGLER_SEND_METRICS=false

if [ "$mode" = real ]; then
	source_dir=${EWR_PRIVATE_DIR:-$root/../ewr-compliance-private}
	if [ ! -d "$source_dir" ]; then
		echo "No private repo at $source_dir. Clone it there, or set EWR_PRIVATE_DIR." >&2
		exit 1
	fi
	private=$(cd "$source_dir" && pwd)
fi

echo "Fetching origin/main."
git -C "$root" fetch --quiet origin main
sha=$(git -C "$root" rev-parse origin/main)
subject=$(git -C "$root" log -1 --format=%s "$sha")

work=$(mktemp -d "${TMPDIR:-/tmp}/ewr-deploy.XXXXXX")
tree="$work/tree"
cleanup() {
	git -C "$root" worktree remove --force "$tree" >/dev/null 2>&1 || true
	rm -rf "$work"
	git -C "$root" worktree prune
}
trap cleanup EXIT

git -C "$root" worktree add --quiet --detach "$tree" "$sha"
cd "$tree"

echo "Installing dependencies in a clean worktree of ${sha:0:12}."
pnpm install --frozen-lockfile --silent

if [ "$mode" = real ]; then
	EWR_PRIVATE_DIR=$private pnpm --silent data:private
	private_sha=$(git -C "$private" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)
	if [ -n "$(git -C "$private" status --porcelain 2>/dev/null)" ]; then
		echo "Warning: $private has uncommitted changes, and they are in this build." >&2
	fi
else
	pnpm --silent data:sample
fi

# Blank, so nothing in an environment or .env file turns the base map on or moves the site.
echo "Building."
env -u BASE_PATH VITE_TILES_URL= VITE_TILES_GLYPHS_URL= pnpm --silent build >"$work/build.log" 2>&1 || {
	cat "$work/build.log" >&2
	echo "The build failed." >&2
	exit 1
}

node "$check" build "$mode" "$tree"

# The same compile `pages deploy` runs on functions/ from the directory it is run in, done here first
# so a dry run shows what the gate would be. Local only: no login.
pnpm wrangler pages functions build functions --outdir "$work/functions" \
	--output-config-path "$work/functions-config.json" --output-routes-path "$work/functions-routes.json" \
	>"$work/functions.log" 2>&1 || {
	cat "$work/functions.log" >&2
	echo "functions/ did not compile." >&2
	exit 1
}
node "$check" functions "$work/functions-config.json" "$work/functions-routes.json"

echo
echo "Going up to Cloudflare Pages project $PROJECT, branch $BRANCH (production):"
echo "  Mode:    $mode"
echo "  Commit:  $sha  $subject"
[ "$mode" = real ] && echo "  Data:    $private at $private_sha"
echo "  Command: pnpm wrangler pages deploy build --project-name $PROJECT --branch $BRANCH --commit-hash $sha"

if [ "$dry_run" = 1 ]; then
	echo
	echo "Dry run: nothing was uploaded."
	exit 0
fi

echo
echo "Before uploading, the project's settings must hold (docs/hosting.md § Access control):"
echo "  Settings > Runtime > Fail open / closed is Fail closed, in Production and in Preview."
echo "  After this deploy, if it changed functions/, the data or a setting, delete the superseded"
echo "  deployments: each stays live at its <hash>.$PROJECT.pages.dev URL with its own copy."

if [ "$mode" = real ] && [ "$yes" = 0 ]; then
	echo
	echo "This publishes the real data to everyone the site's list lets in."
	if ! { exec 3</dev/tty; } 2>/dev/null; then
		echo "No terminal to confirm on. Run it from one, or pass --yes." >&2
		exit 1
	fi
	printf 'Type the project name, %s, to upload: ' "$PROJECT"
	read -r answer <&3
	exec 3<&-
	if [ "$answer" != "$PROJECT" ]; then
		echo "Not confirmed. Nothing was uploaded." >&2
		exit 1
	fi
fi

pnpm wrangler pages deploy build --project-name "$PROJECT" --branch "$BRANCH" \
	--commit-hash "$sha" --commit-message "$subject" 2>&1 | tee "$work/deploy.log"

echo
if grep -q 'Uploading Functions bundle' "$work/deploy.log"; then
	echo "Wrangler uploaded the Functions bundle with this deployment."
else
	echo "WARNING: wrangler did not report uploading the Functions bundle. This deployment may have no list check." >&2
	echo "Check its Functions tab now. If _middleware is not listed, roll production back to the previous" >&2
	echo "deployment in the dashboard, then DELETE this one: a rollback leaves it live at its <hash> URL." >&2
	echo "Its id is in the deployment list (pnpm wrangler pages deployment list --project-name $PROJECT):" >&2
	echo "  pnpm wrangler pages deployment delete <id> --project-name $PROJECT" >&2
	exit 1
fi
echo "Now, in the dashboard, check that this deployment's Functions tab lists _middleware,"
echo "and run the checks in docs/hosting.md § Access control (\"Before going live\") from a browser that is not signed in."
