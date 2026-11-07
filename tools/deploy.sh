#!/usr/bin/env bash
# Deploys the site to its private S3 bucket behind CloudFront (infra/site.tf), from this workstation.
# Never from CI: CI has no access to the real data, and its deploy role cannot write the bucket.
#
#   tools/deploy.sh sample [--dry-run]          the synthetic sample, to test the site and its gate
#   tools/deploy.sh real   [--dry-run] [--yes]  the real data, from ../ewr-compliance-private or EWR_PRIVATE_DIR
#
# It builds from a clean, temporary git worktree of freshly fetched origin/main, never from this
# working tree, which may hold uncommitted work or the wrong static/data. The build has no base map
# and no BASE_PATH. tools/deploy-check.mjs then refuses a build that holds the wrong data, carries
# tiles/, or lacks the sign-in page (static/signin/). The API Lambda is not deployed from here: CI
# does that (.github/workflows/deploy-lambdas.yml).
#
# The upload is `aws s3 sync` in two cache passes, then a CloudFront invalidation:
#   1. _app/immutable/*: named by their hash, so `public, max-age=31536000, immutable`.
#   2. everything else, with --delete: `private, no-cache`, because the pages and data keep their
#      names between builds, sit behind the sign-in and may be real.
# *.mjs (the map's worker) goes up as text/javascript, which the browser needs for a module worker.
# The previous build's chunks are deleted after pass 2, so no page ever names a chunk already gone.
#
# The bucket and distribution come from `terraform output` in infra/ (which needs `terraform init
# -backend-config=backend.config` done there), or from EWR_SITE_BUCKET and EWR_DISTRIBUTION_ID.
# AWS access is the operator's SSO profile, ewr-compliance by default (AWS_PROFILE overrides): this
# script never reads, prints or passes a credential. --dry-run does everything but the upload and the
# invalidation, and needs no AWS login when both values are given in the environment.
set -euo pipefail

PROJECT=ewr-compliance
PROFILE=${AWS_PROFILE:-ewr-compliance}

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

if [ "$mode" = real ]; then
	source_dir=${EWR_PRIVATE_DIR:-$root/../ewr-compliance-private}
	if [ ! -d "$source_dir" ]; then
		echo "No private repo at $source_dir. Clone it there, or set EWR_PRIVATE_DIR." >&2
		exit 1
	fi
	private=$(cd "$source_dir" && pwd)
fi

# The target, before any build, so a missing one fails fast.
tf_output() {
	AWS_PROFILE=$PROFILE terraform -chdir="$root/infra" output -raw "$1" 2>/dev/null || true
}
bucket=${EWR_SITE_BUCKET:-$(tf_output site_bucket)}
distribution=${EWR_DISTRIBUTION_ID:-$(tf_output distribution_id)}
if [ -z "$bucket" ] || [ -z "$distribution" ] || [ "$bucket" = null ] || [ "$distribution" = null ]; then
	echo "No site bucket or distribution. Apply infra/ with site_enabled = true and run this where" >&2
	echo "'terraform -chdir=infra output site_bucket' works, or set EWR_SITE_BUCKET and EWR_DISTRIBUTION_ID." >&2
	exit 1
fi
case $bucket in
	"$PROJECT"-site-*) ;;
	*) echo "Refusing bucket '$bucket': not this project's site bucket ($PROJECT-site-<account>)." >&2; exit 1 ;;
esac

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

node "$check" build "$mode"

# *.mjs goes up in passes of its own, with its type: sync skips a file already uploaded, so a later
# pass could not correct the type of one an earlier pass sent.
immutable=(aws s3 sync build/_app/immutable "s3://$bucket/_app/immutable" --profile "$PROFILE"
	--cache-control "public, max-age=31536000, immutable" --exclude "*.mjs")
immutable_mjs=(aws s3 sync build/_app/immutable "s3://$bucket/_app/immutable" --profile "$PROFILE"
	--cache-control "public, max-age=31536000, immutable" --exclude "*" --include "*.mjs" --content-type "text/javascript")
rest=(aws s3 sync build "s3://$bucket" --profile "$PROFILE" --cache-control "private, no-cache"
	--exclude "_app/immutable/*" --exclude "*.mjs" --delete)
rest_mjs=(aws s3 sync build "s3://$bucket" --profile "$PROFILE" --cache-control "private, no-cache"
	--exclude "*" --include "*.mjs" --exclude "_app/immutable/*" --content-type "text/javascript")
# Last, once no page names them: the previous build's chunks. Nothing is uploaded here, since every
# file is already up from the passes above.
prune=(aws s3 sync build/_app/immutable "s3://$bucket/_app/immutable" --profile "$PROFILE" --delete)
invalidate=(aws cloudfront create-invalidation --profile "$PROFILE" --distribution-id "$distribution" --paths "/*")

echo
echo "Going up to s3://$bucket, distribution $distribution:"
echo "  Mode:    $mode"
echo "  Commit:  $sha  $subject"
[ "$mode" = real ] && echo "  Data:    $private at $private_sha"
echo "  Profile: $PROFILE"
echo "  Pass 1:  ${immutable[*]}"
echo "           ${immutable_mjs[*]}"
echo "  Pass 2:  ${rest[*]}"
echo "           ${rest_mjs[*]}"
echo "  Prune:   ${prune[*]}"
echo "  Then:    ${invalidate[*]}"

if [ "$dry_run" = 1 ]; then
	echo
	echo "Dry run: nothing was uploaded."
	exit 0
fi

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

# The new chunks are in place before any page that names them, and the old ones go only after.
"${immutable[@]}"
"${immutable_mjs[@]}"
"${rest[@]}"
"${rest_mjs[@]}"
"${prune[@]}"
"${invalidate[@]}" >/dev/null

echo
echo "Uploaded and invalidated. From a browser that is not signed in, check that data/index.json and"
echo "nodes/ are refused (infra/README.md, \"After a deploy\")."
