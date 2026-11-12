#!/usr/bin/env bash
# Runs one of the operator's sign-in actions (server/src/operator.ts) against the live user table, with
# the operator's own AWS profile. Called by tools/first-admin, tools/recover-admin, tools/clear-lock and
# tools/erase-user.
#
#   tools/auth-operator.sh first-admin|recover-admin|clear-lock|erase-user
#
# The address is typed at the prompt, never passed as an argument (shell history), and never printed
# back except in the confirmation. The table and the runtime secret's ARN come from `terraform output`
# in infra/ (which needs `terraform init -backend-config=backend.config` done there), or from
# EWR_USERS_TABLE and EWR_RUNTIME_SECRET_ARN. The keys are read from the secret inside the Node process
# and are never printed. Needs server/'s dependencies: cd server && pnpm install --frozen-lockfile.
set -euo pipefail

case ${1:-} in
	first-admin | recover-admin | clear-lock | erase-user) command=$1 ;;
	*) echo "Usage: tools/auth-operator.sh first-admin|recover-admin|clear-lock|erase-user" >&2; exit 2 ;;
esac
[ "$#" -eq 1 ] || { echo "No other arguments: the address is asked for at the prompt." >&2; exit 2; }

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
export AWS_PROFILE=${AWS_PROFILE:-ewr-compliance}

# Sets the variable $1 to terraform output $2, unless it is already set. A failure to read the
# output (no `terraform init` on this workstation, an expired SSO session) is shown as terraform's
# own error, never taken to mean the output is missing: that would send the operator to apply.
# -json, not -raw, so null (auth_enabled off) is told apart from terraform failing.
tf_output() {
	[ -n "${!1:-}" ] && return
	local out err
	err=$(mktemp "${TMPDIR:-/tmp}/ewr-auth-operator.XXXXXX")
	if ! out=$(terraform -chdir="$root/infra" output -no-color -json "$2" 2>"$err"); then
		echo "Can't read 'terraform -chdir=infra output $2' with the $AWS_PROFILE profile:" >&2
		sed 's/^/  /' "$err" >&2
		rm -f "$err"
		echo "Sign in again (aws sso login --profile $AWS_PROFILE), or on a workstation that hasn't yet," >&2
		echo "make infra/backend.config and run terraform init (infra/README.md, H6), then run this again." >&2
		exit 1
	fi
	rm -f "$err"
	if [ "$out" = null ]; then
		echo "'terraform -chdir=infra output $2' is null: the site has no sign-in (auth_enabled is off)." >&2
		exit 1
	fi
	out=${out#\"}
	printf -v "$1" '%s' "${out%\"}"
}
tf_output EWR_USERS_TABLE users_table
tf_output EWR_RUNTIME_SECRET_ARN auth_runtime_secret_arn
table=$EWR_USERS_TABLE
secret=$EWR_RUNTIME_SECRET_ARN
region=${AWS_REGION:-af-south-1}
case $table in
	ewr-compliance-*) ;;
	*) echo "Refusing table '$table': not this project's." >&2; exit 1 ;;
esac

if [ ! -d "$root/server/node_modules/@absence0760/auth-kit" ]; then
	echo "server/ is not installed: cd server && pnpm install --frozen-lockfile (needs read access to auth-kit)." >&2
	exit 1
fi

echo "Table $table in $region, profile $AWS_PROFILE."
cd "$root/server"
EWR_USERS_TABLE=$table EWR_RUNTIME_SECRET_ARN=$secret AWS_REGION=$region exec node src/operator.ts "$command"
