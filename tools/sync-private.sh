#!/usr/bin/env bash
# `pnpm data:private`: copies the real data and the tests pinned to it from the private repo into
# this checkout, where they run with the code here. Everything it writes is ignored by git.
#
#   static/data/*      to static/data/
#   tests/unit/*       to src/private/
#   tests/e2e/*        to e2e/tests/private/
#
# The private repo is ../ewr-compliance-private, or EWR_PRIVATE_DIR. Unit tests import with #lib/...
# and specs with #e2e/..., because a relative import would not survive the copy.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
source_dir=${EWR_PRIVATE_DIR:-$root/../ewr-compliance-private}

if [ ! -d "$source_dir" ]; then
	echo "No private repo at $source_dir. Clone it there, or set EWR_PRIVATE_DIR." >&2
	exit 1
fi
private=$(cd "$source_dir" && pwd)

for needed in static/data/index.json tests/unit tests/e2e; do
	if [ ! -e "$private/$needed" ]; then
		echo "$private has no $needed, so it is not the private repo." >&2
		exit 1
	fi
done
if [ "$private" = "$root" ]; then
	echo "EWR_PRIVATE_DIR points at this checkout." >&2
	exit 1
fi

mkdir -p "$root/static/data"
find "$root/static/data" -mindepth 1 -maxdepth 1 -delete
# map.json is skipped: the rivers it held are public now, in static/geo, and the private repo may still have a copy.
find "$private/static/data" -mindepth 1 -maxdepth 1 ! -name map.json -exec cp -- {} "$root/static/data/" \;

for pair in "tests/unit:src/private" "tests/e2e:e2e/tests/private"; do
	from=$private/${pair%%:*}
	to=$root/${pair##*:}
	rm -rf "$to"
	mkdir -p "$to"
	cp -r "$from/." "$to/"
done

echo "Copied real data and tests from $private."
echo "It is ignored by git and must stay out of any commit in this repo."
