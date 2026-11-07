// The pipeline Lambda's entry (infra/dws.tf). Two events:
//
//   { "mode": "daily" }                                     the EventBridge rule, once a day
//   { "mode": "backfill", "from": "YYYY-MM-DD", "to": … }   one item of the Step Functions backfill
//
// Environment: DWS_BUCKET, the store's bucket; DWS_CONTACT, the operator's address for the user agent
// (optional; DWS can then write before blocking us). DWS_API_KEY_SECRET_ARN names the secret the
// operator fills when DWS issues an API key (the plan's Q1). Nothing reads it yet: the HyData page
// needs no key, and the grant is there so the API source can be added without an IAM change.
import { PoliteClient } from './polite.ts';
import { checkWindow, emitLag, runBackfill, runDaily, sastDay, summary, type Log, type RunResult } from './run.ts';
import { S3Store } from './store.ts';

/** Time kept back from the Lambda's budget to save the status and index after the last station. */
export const SAVE_MARGIN_MS = 30_000;

interface LambdaContext {
	getRemainingTimeInMillis(): number;
}

/** Lambda's JSON log format takes an object; a plain run (a test) gets one JSON line. */
export const log: Log = (level, fields) => {
	if (process.env.AWS_LAMBDA_LOG_FORMAT === 'JSON') console[level](fields);
	else console[level](JSON.stringify(fields));
};

export async function handler(event: unknown, context: LambdaContext): Promise<ReturnType<typeof summary>> {
	const bucket = process.env.DWS_BUCKET;
	if (!bucket) throw new Error('DWS_BUCKET is not set');
	const remainingMs = context.getRemainingTimeInMillis();
	const now = Date.now;
	const deadline = now() + remainingMs - SAVE_MARGIN_MS;
	const client = new PoliteClient({ contact: process.env.DWS_CONTACT, mayWait: (ms) => now() + ms < deadline });
	const ctx = { store: new S3Store(bucket), client, now, deadline, remainingMs, log, emitLag };
	const e = (typeof event === 'object' && event !== null ? event : {}) as Record<string, unknown>;
	let result: RunResult;
	if (e.mode === 'daily') {
		result = await runDaily(ctx);
		if (result.stopped === 'busy' || result.stopped === 'no_stations') log('warn', { event: 'dws_run', ...summary(result) });
	} else if (e.mode === 'backfill') {
		result = await runBackfill(ctx, checkWindow(e.from, e.to, sastDay(now())));
	} else {
		throw new Error('Unknown event: the mode is "daily" or "backfill"');
	}
	return summary(result);
}
