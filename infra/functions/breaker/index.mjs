// The spend circuit breaker (infra/breaker.tf). Subscribed to the breaker SNS topic, which only the
// trip alarms (ewr-compliance-breaker-api-* and -dws-*) may publish to: on an ALARM it sets the
// reserved concurrency of the function that alarm watches to 0, so no copy of it runs, and no
// compute or request is billed, until the operator resets it (`pnpm infra:breaker-reset`,
// tools/breaker-reset.sh). The same alarms mail the regional alert topic, so the operator hears of
// it from them. Its role holds nothing but lambda:PutFunctionConcurrency on the protected functions
// and its own log group.
//
// PROTECTED (environment) maps each trip alarm's name prefix to the function it stops:
//   {"ewr-compliance-breaker-api-":"ewr-compliance-api","ewr-compliance-breaker-dws-":"ewr-compliance-dws"}
// A notification it can't read, or from an alarm whose name matches no prefix, stops every protected
// function: only the trip alarms can publish to the topic, so an unreadable message is still theirs,
// and stopping too much is the safe way round.
//
// Plain JavaScript, no bundle: the AWS SDK v3 comes from the nodejs24.x runtime. It is imported
// lazily, so the test (tools/breaker.test.ts) runs the logic with a fake and no SDK installed.

/** The alarm names and states in an SNS event; a record that isn't an alarm notification yields nulls. */
export function alarmsIn(event) {
	return (event?.Records ?? []).map((r) => {
		try {
			const m = JSON.parse(r?.Sns?.Message ?? '');
			return {
				alarm: typeof m.AlarmName === 'string' ? m.AlarmName : null,
				state: typeof m.NewStateValue === 'string' ? m.NewStateValue : null
			};
		} catch {
			return { alarm: null, state: null };
		}
	});
}

/** The protected map from the environment: prefix -> function name. Refuses an empty or malformed one. */
export function protectedFunctions(raw) {
	let map;
	try {
		map = JSON.parse(raw ?? '');
	} catch {
		throw new Error('PROTECTED is not JSON');
	}
	const entries = map && typeof map === 'object' && !Array.isArray(map) ? Object.entries(map) : [];
	if (entries.length === 0 || !entries.every(([p, f]) => p && typeof f === 'string' && f)) {
		throw new Error('PROTECTED must map at least one alarm prefix to a function name');
	}
	return entries;
}

/**
 * The functions to stop. A readable non-ALARM notification (OK, INSUFFICIENT_DATA) stops nothing;
 * an ALARM stops the function its name's prefix maps to; anything else, or an empty event, stops all.
 */
export function functionsToStop(alarms, entries) {
	const all = [...new Set(entries.map(([, f]) => f))];
	if (alarms.length === 0) return all;
	const stop = new Set();
	for (const a of alarms) {
		if (a.state !== null && a.state !== 'ALARM') continue;
		const hit = a.alarm === null ? undefined : entries.find(([prefix]) => a.alarm.startsWith(prefix));
		if (a.state === null || !hit) return all;
		stop.add(hit[1]);
	}
	return all.filter((f) => stop.has(f));
}

export function createBreaker({ putConcurrency, log = console.log, env = process.env }) {
	return async (event) => {
		const entries = protectedFunctions(env.PROTECTED);
		const alarms = alarmsIn(event);
		const stop = functionsToStop(alarms, entries);
		if (stop.length === 0) {
			log(JSON.stringify({ event: 'breaker.ignored', alarms }));
			return { stopped: [] };
		}
		// Every one is attempted; a failure is thrown after, so SNS's async invoke retries it and the
		// breaker-errors alarm mails, without one refusal leaving the other function running.
		const failures = [];
		for (const name of stop) {
			try {
				await putConcurrency(name, 0);
				log(JSON.stringify({ event: 'breaker.tripped', function: name, reservedConcurrency: 0, alarms }));
			} catch (err) {
				failures.push(`${name}: ${err?.message ?? err}`);
			}
		}
		if (failures.length > 0) throw new Error(`breaker failed to stop ${failures.join('; ')}`);
		return { stopped: stop };
	};
}

let client;

export const handler = async (event) => {
	const { LambdaClient, PutFunctionConcurrencyCommand } = await import('@aws-sdk/client-lambda');
	client ??= new LambdaClient({});
	const putConcurrency = (FunctionName, ReservedConcurrentExecutions) =>
		client.send(new PutFunctionConcurrencyCommand({ FunctionName, ReservedConcurrentExecutions }));
	return createBreaker({ putConcurrency })(event);
};
