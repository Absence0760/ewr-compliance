#!/usr/bin/env bash
# Reset the spend circuit breaker (infra/breaker.tf, decision Q6) after a trip, once the cause is
# found (docs/hosting.md § Cost controls). The operator's, with their AWS profile:
#
#   pnpm infra:breaker-reset             (or tools/breaker-reset.sh; AWS_PROFILE, default ewr-compliance)
#
#   1. Lists the trip alarms, ewr-compliance-breaker-api-* and -dws-* (never breaker-errors). None
#      found is a wrong region or profile: it stops there, having changed nothing.
#   2. Refuses while the current clock hour's Duration of a protected function is already over its
#      duration trip: the hourly alarm would go straight back to ALARM and trip again on the load that
#      tripped it. BREAKER_RESET_NOW=1 overrides.
#   3. Puts every trip alarm back to OK. A trip fires only on a transition INTO ALARM, so an alarm
#      left in ALARM can't trip again: after this the next evaluation goes back to ALARM, and trips
#      the breaker again, if the flood is still on. A plain `terraform apply` reopens the functions but
#      leaves the alarms in ALARM, unarmed, so use this instead.
#   4. Only then reopens each function the breaker set to 0, to Terraform's value. The API's is, in
#      order: BREAKER_RESET_API_CONCURRENCY (a number, or "none"); `terraform -chdir=infra output
#      -raw api_reserved_concurrency`; api_reserved_concurrency in the tfvars (EWR_TFVARS, default
#      ~/github/infra-secrets/ewr-compliance/prod.tfvars; a readable file without the line is
#      "none", unreserved). With none of the three it refuses (exit 2) before changing anything,
#      rather than guess "unreserved" and leave the API uncapped. The DWS pipeline goes back to
#      unreserved (Terraform reserves it none). A function not at 0 is left as it is.
#   5. Redrives nothing, on purpose. The API has no queue. The pipeline's DLQ holds only daily runs'
#      {"mode":"daily"} events, which the next day's run makes redundant (infra/dws.tf), so it reports
#      their count and says to purge it. A backfill the trip failed is resumed by starting the same
#      plan again (infra/README.md H11, step 5).
#
# Region: BREAKER_RESET_REGION, else `terraform -chdir=infra output -raw aws_region`, else af-south-1.
# Needs the AWS CLI and the profile's credentials; it reads no secret.
# Tests: tools/breaker-reset.test.ts, with a fake `aws` on PATH.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
profile=${AWS_PROFILE:-ewr-compliance}
project=ewr-compliance
tfvars=${EWR_TFVARS:-$HOME/github/infra-secrets/ewr-compliance/prod.tfvars}

region=${BREAKER_RESET_REGION:-}
if [ -z "$region" ]; then
	region=$(AWS_PROFILE="$profile" terraform -chdir="$root/infra" output -raw aws_region 2>/dev/null || true)
fi
region=${region:-af-south-1}

aws_() { aws --profile "$profile" --region "$region" "$@"; }

# Prefix (api, dws) -> function, as infra/breaker.tf names them.
function_of() {
	case $1 in
		api) echo "$project-api" ;;
		dws) echo "$project-dws" ;;
	esac
}

# Terraform's reserved concurrency for the API: a number, or "none" (unreserved). Empty when no
# source can be read; step 1 refuses then, if the API is one of the functions to reopen.
api_concurrency=${BREAKER_RESET_API_CONCURRENCY:-}
api_source="BREAKER_RESET_API_CONCURRENCY"
if [ -z "$api_concurrency" ]; then
	api_concurrency=$(AWS_PROFILE="$profile" terraform -chdir="$root/infra" output -raw api_reserved_concurrency 2>/dev/null || true)
	api_source="terraform output"
fi
if [ -z "$api_concurrency" ] && [ -r "$tfvars" ]; then
	api_concurrency=$(sed -nE 's/^[[:space:]]*api_reserved_concurrency[[:space:]]*=[[:space:]]*([0-9]+).*/\1/p' "$tfvars" | head -n 1)
	api_concurrency=${api_concurrency:-none}
	api_source="$tfvars"
fi
case $api_concurrency in
	'' | none | [1-9] | [1-9][0-9]) ;;
	*) echo "The API's reserved concurrency from $api_source must be a number from 1 to 99, or none; got '$api_concurrency'." >&2; exit 2 ;;
esac
concurrency_of() {
	case $1 in
		api) echo "$api_concurrency" ;;
		dws) echo none ;;
	esac
}

echo "Breaker reset in $region (profile $profile)."

# 1. The trip alarms, by protected function.
prefixes=""
alarms=""
for p in api dws; do
	found=$(aws_ cloudwatch describe-alarms --alarm-name-prefix "$project-breaker-$p-" --query 'MetricAlarms[].AlarmName' --output text)
	if [ -n "$found" ] && [ "$found" != None ]; then
		prefixes="$prefixes $p"
		alarms="$alarms $found"
	fi
done
if [ -z "$prefixes" ]; then
	echo "No $project-breaker-api-* or -dws-* alarms in $region: wrong region or profile?" >&2
	exit 1
fi
case " $prefixes " in
	*" api "*)
		if [ -z "$api_concurrency" ]; then
			echo "Can't tell the API's reserved concurrency: no BREAKER_RESET_API_CONCURRENCY, no 'terraform output api_reserved_concurrency' (run where infra/ is initialised), and no readable $tfvars." >&2
			echo "Set BREAKER_RESET_API_CONCURRENCY to the number in prod.tfvars (or none if it sets none) and run again. Nothing was changed." >&2
			exit 2
		fi
		;;
esac

# 2. An hour already over a duration trip would trip again at once.
hour_start=$(date -u +%Y-%m-%dT%H:00:00Z)
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
for p in $prefixes; do
	fn=$(function_of "$p")
	threshold=$(aws_ cloudwatch describe-alarms --alarm-names "$project-breaker-$p-duration" --query 'MetricAlarms[0].Threshold' --output text)
	used=$(aws_ cloudwatch get-metric-statistics --namespace AWS/Lambda --metric-name Duration \
		--dimensions "Name=FunctionName,Value=$fn" --statistics Sum --period 3600 \
		--start-time "$hour_start" --end-time "$now" --query 'Datapoints[0].Sum' --output text)
	if [ -n "$used" ] && [ "$used" != None ] && [ -n "$threshold" ] && [ "$threshold" != None ] && [ "${BREAKER_RESET_NOW:-0}" != 1 ] &&
		awk -v u="$used" -v t="$threshold" 'BEGIN { exit !(u + 0 > t + 0) }'; then
		echo "$fn has already run $used ms this clock hour, over its duration trip ($threshold ms): resetting now would trip it again at once." >&2
		echo "Wait for the next hour (UTC), or run with BREAKER_RESET_NOW=1 to reset anyway. Nothing was changed." >&2
		exit 2
	fi
done

# 3. Re-arm: every trip alarm to OK, before anything reopens.
for alarm in $alarms; do
	aws_ cloudwatch set-alarm-state --alarm-name "$alarm" --state-value OK \
		--state-reason "Breaker reset by the operator (tools/breaker-reset.sh)"
	echo "Alarm $alarm: OK (it trips again if the load is still on)."
done

# 4. Reopen what the breaker closed.
for p in $prefixes; do
	fn=$(function_of "$p")
	current=$(aws_ lambda get-function-concurrency --function-name "$fn" --query ReservedConcurrentExecutions --output text)
	if [ "$current" != 0 ]; then
		echo "$fn: reserved concurrency is ${current/None/unreserved}, not 0: left as it is."
		continue
	fi
	want=$(concurrency_of "$p")
	if [ "$want" = none ]; then
		aws_ lambda delete-function-concurrency --function-name "$fn"
		echo "$fn: unreserved again, as Terraform has it. It runs again."
	else
		aws_ lambda put-function-concurrency --function-name "$fn" --reserved-concurrent-executions "$want" >/dev/null
		echo "$fn: reserved concurrency $want again, as Terraform has it. It runs again."
	fi
done

# 5. Nothing to redrive; say what is waiting.
case " $prefixes " in
	*" dws "*)
		dlq_url=$(aws_ sqs get-queue-url --queue-name "$project-dws-dlq" --query QueueUrl --output text)
		waiting=$(aws_ sqs get-queue-attributes --queue-url "$dlq_url" --attribute-names ApproximateNumberOfMessages --query Attributes.ApproximateNumberOfMessages --output text)
		if [ "${waiting:-0}" != 0 ] && [ "${waiting:-0}" != None ]; then
			echo "$project-dws-dlq holds $waiting daily run event(s) from while it was stopped. Not redriven: the next daily run does the same work. Purge it to clear the dws-dlq alarm:"
			echo "  aws sqs purge-queue --queue-url $dlq_url --region $region --profile $profile"
		else
			echo "$project-dws-dlq is empty."
		fi
		echo "A backfill that failed while the pipeline was stopped resumes by starting the same plan again (infra/README.md H11, step 5)."
		;;
esac
