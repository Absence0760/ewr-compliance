#!/usr/bin/env bash
# Deploys the site to its private S3 bucket behind CloudFront (infra/site.tf), from this workstation.
# Never from CI: CI has no access to the real data, and its deploy role cannot write the bucket.
#
#   tools/deploy.sh sample [--dry-run] [--skip-ci-check]
#       the synthetic sample, to test the site and its gate
#   tools/deploy.sh real   [--dry-run] [--yes] [--allow-dirty] [--skip-ci-check]
#       the real data, from ../ewr-compliance-private or EWR_PRIVATE_DIR
#
# Before it builds it refuses (tools/deploy-check.mjs, checkSources):
#   - an origin/main whose `CI gate` check has not passed, asked of GitHub with gh. --skip-ci-check
#     publishes it anyway, saying so.
#   - for real, a private repo that is not exactly what its upstream holds, once fetched: uncommitted
#     changes, commits not pushed, or commits not pulled. --allow-dirty publishes it as it stands.
# --dry-run reports what a real run would refuse and goes on.
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
# invalidation, and needs no AWS login for the site when both values are given in the environment;
# in real mode its last step, the station list's check, still reads `terraform output` and fails the
# dry run without it (before H6 there is none), as the real run would.
#
# A real deploy then uploads the DWS store's station list (tools/dws-stations.sh), built from the same
# private repo's gauge links; with no store (dws_enabled off) that step says so and does nothing.
set -euo pipefail

PROJECT=ewr-compliance
PROFILE=${AWS_PROFILE:-ewr-compliance}

usage() {
	echo "Usage: tools/deploy.sh sample|real [--dry-run] [--yes] [--allow-dirty] [--skip-ci-check]" >&2
	exit 2
}

mode=
dry_run=0
yes=0
allow_dirty=0
skip_ci_check=0
for arg in "$@"; do
	case $arg in
		sample | real) [ -z "$mode" ] || usage; mode=$arg ;;
		--dry-run) dry_run=1 ;;
		--yes) yes=1 ;;
		--allow-dirty) allow_dirty=1 ;;
		--skip-ci-check) skip_ci_check=1 ;;
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

# What is about to be published, judged before anything is built: CI on that commit, and for real
# the private repo against its upstream.
ci=unknown
if command -v gh >/dev/null; then
	if runs=$(gh api "repos/Absence0760/$PROJECT/commits/$sha/check-runs?check_name=CI%20gate" \
		--jq '[.check_runs[] | .conclusion // "pending"] | if length == 0 then "none" elif any(. == "success") then "success" elif any(. == "pending") then "pending" else "failure" end' 2>/dev/null); then
		ci=$runs
	fi
fi
private_json=null
if [ "$mode" = real ]; then
	fetched=false
	git -C "$private" fetch --quiet 2>/dev/null && fetched=true
	head=$(git -C "$private" rev-parse HEAD)
	dirty=false
	[ -z "$(git -C "$private" status --porcelain)" ] || dirty=true
	upstream=$(git -C "$private" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
	upstream_sha=
	ahead=0
	behind=0
	if [ -n "$upstream" ]; then
		upstream_sha=$(git -C "$private" rev-parse '@{u}')
		read -r ahead behind < <(git -C "$private" rev-list --left-right --count 'HEAD...@{u}')
	fi
	private_json=$(printf '{"fetched":%s,"dirty":%s,"head":"%s","upstream":%s,"upstreamSha":%s,"ahead":%d,"behind":%d}' \
		"$fetched" "$dirty" "$head" "$([ -n "$upstream" ] && printf '"%s"' "$upstream" || echo null)" \
		"$([ -n "$upstream_sha" ] && printf '"%s"' "$upstream_sha" || echo null)" "$ahead" "$behind")
fi
bool() { [ "$1" = 1 ] && echo true || echo false; }
echo "Sources:"
node "$check" sources "$(printf '{"mode":"%s","dryRun":%s,"allowDirty":%s,"skipCiCheck":%s,"sha":"%s","ci":"%s","private":%s}' \
	"$mode" "$(bool "$dry_run")" "$(bool "$allow_dirty")" "$(bool "$skip_ci_check")" "$sha" "$ci" "$private_json")"

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
	private_upstream=$(git -C "$private" rev-parse --short=12 '@{u}' 2>/dev/null || echo none)
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
[ "$mode" = real ] && echo "  Data:    $private at $private_sha (upstream at $private_upstream)"
echo "  Profile: $PROFILE"
echo "  Pass 1:  ${immutable[*]}"
echo "           ${immutable_mjs[*]}"
echo "  Pass 2:  ${rest[*]}"
echo "           ${rest_mjs[*]}"
echo "  Prune:   ${prune[*]}"
echo "  Then:    ${invalidate[*]}"
[ "$mode" = real ] && echo "  Last:    tools/dws-stations.sh, the DWS store's station list from the same private repo"

if [ "$dry_run" = 1 ]; then
	[ "$mode" = real ] && "$here/dws-stations.sh" --dry-run --gauges "$private/static/data/gauges.json"
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

# The DWS store's station list, from the same private repo: real only, and only once the store exists.
[ "$mode" = real ] && "$here/dws-stations.sh" --gauges "$private/static/data/gauges.json"

echo
echo "Uploaded and invalidated. From a browser that is not signed in, check that data/index.json and"
echo "nodes/ are refused (infra/README.md, \"After a deploy\")."
