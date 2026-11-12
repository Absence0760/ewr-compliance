#!/usr/bin/env bash
# Uploads the DWS store's station list, config/stations.json, from the private repo's gauge links
# (tools/dws-stations.mjs), to the store's bucket (infra/dws.tf). tools/deploy.sh real calls it after
# the site's upload; the sample deploy uploads none. From this workstation only: the list is client
# material, so it never passes through CI, a workflow input or a log. This prints how many stations,
# never which.
#
#   tools/dws-stations.sh [--dry-run] [--gauges <gauges.json>]
#
# The gauges.json is the private repo's static/data/gauges.json (EWR_PRIVATE_DIR, or
# ../ewr-compliance-private), unless --gauges names another. The bucket comes from `terraform output
# dws_bucket` in infra/, or EWR_DWS_BUCKET. When the output is null or absent (dws_enabled off;
# Terraform drops a null output from its state) it says so and does nothing; when terraform itself fails (an expired SSO session, no `terraform init`) it stops
# with an error, so a real deploy never skips the list without saying so. AWS access is the
# operator's SSO profile, ewr-compliance by default (AWS_PROFILE overrides). The pipeline reads the
# new list on its next run.
set -euo pipefail

PROJECT=ewr-compliance
PROFILE=${AWS_PROFILE:-ewr-compliance}

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/.." && pwd)

dry_run=0
gauges=
while [ $# -gt 0 ]; do
	case $1 in
		--dry-run) dry_run=1 ;;
		--gauges) [ $# -ge 2 ] || { echo "--gauges needs a path." >&2; exit 2; }; gauges=$2; shift ;;
		*) echo "Usage: tools/dws-stations.sh [--dry-run] [--gauges <gauges.json>]" >&2; exit 2 ;;
	esac
	shift
done

if [ -z "$gauges" ]; then
	gauges=${EWR_PRIVATE_DIR:-$root/../ewr-compliance-private}/static/data/gauges.json
fi
if [ ! -f "$gauges" ]; then
	echo "No gauges.json at $gauges. Clone the private repo beside this one, or set EWR_PRIVATE_DIR." >&2
	exit 1
fi

umask 077
work=$(mktemp -d "${TMPDIR:-/tmp}/ewr-dws-stations.XXXXXX")
trap 'rm -rf "$work"' EXIT

if [ -n "${EWR_DWS_BUCKET:-}" ]; then
	bucket=$EWR_DWS_BUCKET
else
	# Every output, as JSON, not `output dws_bucket`: Terraform keeps no null output in its state, so
	# with dws_enabled off `output dws_bucket` fails "not found", the same as terraform failing. Only
	# terraform's own failure is an error; an output that is absent or null means no store.
	if ! all=$(AWS_PROFILE=$PROFILE terraform -chdir="$root/infra" output -json 2>"$work/err"); then
		echo "Can't read 'terraform -chdir=infra output' with the $PROFILE profile, so the station list was not uploaded:" >&2
		sed 's/^/  /' "$work/err" >&2
		echo "Sign in again (aws sso login --profile $PROFILE), or run 'terraform init' in infra/, then run tools/dws-stations.sh again." >&2
		exit 1
	fi
	if ! out=$(printf '%s' "$all" | node -e 'const o = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(JSON.stringify(o.dws_bucket?.value ?? null));' 2>"$work/err"); then
		echo "'terraform -chdir=infra output -json' did not print JSON, so the station list was not uploaded:" >&2
		sed 's/^/  /' "$work/err" >&2
		exit 1
	fi
	if [ "$out" = null ]; then
		echo "No DWS store (dws_enabled is off): no station list uploaded."
		exit 0
	fi
	bucket=${out#\"}
	bucket=${bucket%\"}
fi
if [ -z "$bucket" ]; then
	echo "'terraform -chdir=infra output dws_bucket' is empty: no station list uploaded." >&2
	exit 1
fi
case $bucket in
	"$PROJECT"-dws-*) ;;
	*) echo "Refusing bucket '$bucket': not this project's DWS store ($PROJECT-dws-<account>)." >&2; exit 1 ;;
esac

list=$work/stations.json
node "$here/dws-stations.mjs" "$gauges" >"$list"
count=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).stations.length)' "$list")

if [ "$dry_run" = 1 ]; then
	echo "Dry run: would upload $count stations to s3://$bucket/config/stations.json."
	exit 0
fi
aws s3 cp "$list" "s3://$bucket/config/stations.json" --profile "$PROFILE" --content-type application/json --only-show-errors
echo "Uploaded $count stations to s3://$bucket/config/stations.json. The pipeline reads them on its next run."
