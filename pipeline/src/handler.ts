// The pipeline Lambda's entry (infra/dws.tf). Two events:
//
//   { "mode": "daily" }                                     the EventBridge rule, once a day
//   { "mode": "backfill", "from": "YYYY-MM-DD", "to": … }   one item of the Step Functions backfill
//
// Either may add "ignoreStop": true, the operator's override of the cool-down after a run DWS stopped
// (run.ts coolingUntil), for a pull by hand once the reason is understood.
//
// An error that is not one of the pipeline's own (an S3 SDK error, say) can name a key, and so a
// station, in its message. It is logged by name and status only, and leaves the function as
// PipelineFailed with a fixed message, so no station reaches the DLQ or the backfill's history.
//
// Environment: DWS_BUCKET, the store's bucket; DWS_CONTACT, the operator's address for the user agent
// (optional; DWS can then write before blocking us). DWS_API_KEY_SECRET_ARN names the secret the
// operator fills when DWS issues an API key (the plan's Q1). Nothing reads it yet: the HyData page
// needs no key, and the grant is there so the API source can be added without an IAM change.
import { OWN_ERRORS, PipelineError, StoreFormatError } from './errors.ts';
import { PoliteClient } from './polite.ts';
import { checkWindow, emitLag, runBackfill, runDaily, sastDay, summary, type Log, type RunResult } from './run.ts';
import { S3Store, type Store } from './store.ts';

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

/** The handler over a store (the bucket in Lambda; a stub in the tests). */
export const makeHandler =
	(storeFor: (bucket: string) => Store) =>
	async (event: unknown, context: LambdaContext): Promise<ReturnType<typeof summary>> => {
		try {
			return await run(event, context, storeFor);
		} catch (err) {
			const name = (err as { name?: unknown })?.name;
			// The pipeline's own failures, as against DWS stopping a run or an expected wait: the dws-failed alarm reads these lines.
			if (name === 'StoreFormatError' || name === 'DwsStationsFailed') log('error', { event: 'dws_error', error: name, status: null });
			if (typeof name === 'string' && OWN_ERRORS.has(name)) throw err;
			log('error', { event: 'dws_error', error: typeof name === 'string' ? name.slice(0, 60) : 'unknown', status: (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode ?? null });
			throw new PipelineError();
		}
	};

export const handler = makeHandler((bucket) => new S3Store(bucket));

async function run(event: unknown, context: LambdaContext, storeFor: (bucket: string) => Store): Promise<ReturnType<typeof summary>> {
	const bucket = process.env.DWS_BUCKET;
	if (!bucket) throw new StoreFormatError('DWS_BUCKET is not set');
	const remainingMs = context.getRemainingTimeInMillis();
	const now = Date.now;
	const deadline = now() + remainingMs - SAVE_MARGIN_MS;
	const client = new PoliteClient({ contact: process.env.DWS_CONTACT, deadline, mayWait: (ms) => now() + ms < deadline });
	const e = (typeof event === 'object' && event !== null ? event : {}) as Record<string, unknown>;
	const ctx = { store: storeFor(bucket), client, now, deadline, remainingMs, log, emitLag, ignoreStop: e.ignoreStop === true };
	let result: RunResult;
	if (e.mode === 'daily') {
		result = await runDaily(ctx);
		if (result.stopped === 'busy' || result.stopped === 'no_stations') log('warn', { event: 'dws_run', ...summary(result) });
	} else if (e.mode === 'backfill') {
		result = await runBackfill(ctx, checkWindow(e.from, e.to, sastDay(now())));
	} else {
		throw new StoreFormatError('Unknown event: the mode is "daily" or "backfill"');
	}
	return summary(result);
}
