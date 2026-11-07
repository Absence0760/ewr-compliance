#!/usr/bin/env bash
# Runs one of the operator's sign-in actions (server/src/operator.ts) against the live user table, with
# the operator's own AWS profile. Called by tools/first-admin, tools/recover-admin and tools/erase-user.
#
#   tools/auth-operator.sh first-admin|recover-admin|erase-user
#
# The address is typed at the prompt, never passed as an argument (shell history), and never printed
# back except in the confirmation. The table and the runtime secret's ARN come from `terraform output`
# in infra/ (which needs `terraform init -backend-config=backend.config` done there), or from
# EWR_USERS_TABLE and EWR_RUNTIME_SECRET_ARN. The keys are read from the secret inside the Node process
# and are never printed. Needs server/'s dependencies: cd server && pnpm install --frozen-lockfile.
set -euo pipefail

case ${1:-} in
	first-admin | recover-admin | erase-user) command=$1 ;;
	*) echo "Usage: tools/auth-operator.sh first-admin|recover-admin|erase-user" >&2; exit 2 ;;
esac
[ "$#" -eq 1 ] || { echo "No other arguments: the address is asked for at the prompt." >&2; exit 2; }

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
export AWS_PROFILE=${AWS_PROFILE:-ewr-compliance}

tf_output() {
	terraform -chdir="$root/infra" output -raw "$1" 2>/dev/null || true
}
table=${EWR_USERS_TABLE:-$(tf_output users_table)}
secret=${EWR_RUNTIME_SECRET_ARN:-$(tf_output auth_runtime_secret_arn)}
region=${AWS_REGION:-af-south-1}
if [ -z "$table" ] || [ -z "$secret" ] || [ "$table" = null ] || [ "$secret" = null ]; then
	echo "No user table or runtime secret. Apply infra/ with auth_enabled = true and run this where" >&2
	echo "'terraform -chdir=infra output users_table' works, or set EWR_USERS_TABLE and EWR_RUNTIME_SECRET_ARN." >&2
	exit 1
fi
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
