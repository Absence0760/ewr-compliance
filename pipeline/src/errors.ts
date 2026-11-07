// How a pull fails. Each error's `name` is what Lambda reports as the invocation's error type, and
// what the backfill state machine matches its Retry and Catch rules on (infra/dws_backfill.tf), so the
// names are fixed. Messages are our own wording, never the page's text: a page can quote a station,
// and only the fixed labels below go to a log.

/** DWS answered HTTP 403: it refuses this address. The run stops at once and nothing asks again until tomorrow. */
export class DwsRefusedError extends Error {
	override readonly name = 'DwsRefused';
	constructor() {
		super('DWS answered HTTP 403: the run stopped, and nothing is retried');
	}
}

/** DWS kept answering 429 or 503, or asked for a wait longer than this run can give. The run stops. */
export class DwsThrottledError extends Error {
	override readonly name = 'DwsThrottled';
	constructor(
		readonly status: number,
		readonly retryAfterSeconds: number | null
	) {
		super(`DWS answered HTTP ${status} and asked us to slow down (Retry-After ${retryAfterSeconds === null ? 'absent' : `${retryAfterSeconds} s`}): the run stopped`);
	}
}

/** DWS answered with its ScriptServer error page instead of data: its own backend is down. The run stops. */
export class DwsServerError extends Error {
	override readonly name = 'DwsServerError';
	constructor() {
		super('DWS answered with its ScriptServer error page instead of data: the run stopped');
	}
}

/** DWS failed to answer usefully for MAX_UNAVAILABLE_IN_A_ROW stations running: it is down, so the run stops asking. */
export class DwsDownError extends Error {
	override readonly name = 'DwsDown';
	constructor(count: number) {
		super(`DWS failed to answer for ${count} stations in a row: the run stopped`);
	}
}

/** The last run was stopped by DWS too recently for this one to ask (run.ts STOP_COOLDOWN_HOURS). Not retried. */
export class CoolingDownError extends Error {
	override readonly name = 'DwsCoolingDown';
	constructor(reason: string, until: string) {
		super(`The last run stopped (${reason}); nothing asks DWS again until ${until}, unless the event says ignoreStop`);
	}
}

/** Anything else that failed: its own message can name an S3 key, so only this fixed one leaves the function. */
export class PipelineError extends Error {
	override readonly name = 'PipelineFailed';
	constructor() {
		super('The pipeline failed; its log has the error name');
	}
}

/** One station's page didn't answer usefully: a network failure, a timeout, another status, a body too large or cut short. */
export class DwsUnavailableError extends Error {
	override readonly name = 'DwsUnavailable';
	constructor(readonly label: string) {
		super(`DWS did not answer usefully: ${label}`);
	}
}

/** One station's page answered, but not as the daily table this reads. `label` is the fixed text logged for it. */
export class DwsFormatError extends Error {
	override readonly name = 'DwsFormatError';
	constructor(readonly label: string) {
		super(`The DWS page is not the daily table this reads: ${label}`);
	}
}

/** Something in our own store isn't what this pipeline writes. A bug or a hand edit: never guessed at. */
export class StoreFormatError extends Error {
	override readonly name = 'StoreFormatError';
}

/** Another run holds the lease on DWS (lease.ts). The backfill retries; the daily run ends quietly. */
export class LeaseBusyError extends Error {
	override readonly name = 'LeaseBusy';
	constructor(readonly holder: string | null) {
		super(`Another run (${holder ?? 'unknown'}) holds the DWS lease`);
	}
}

/** The invocation's time ran out before every station of a backfill window was done. Retried: done stations are skipped. */
export class WindowUnfinishedError extends Error {
	override readonly name = 'WindowUnfinished';
	constructor(left: number) {
		super(`The invocation ran out of time with ${left} station${left === 1 ? '' : 's'} of the window left`);
	}
}

/** A backfill window finished with a station whose page failed. Not retried: the operator looks at the log first. */
export class StationsFailedError extends Error {
	override readonly name = 'DwsStationsFailed';
	constructor(count: number) {
		super(`${count} station${count === 1 ? '' : 's'} of the window failed; the log names each with its check`);
	}
}

/** The errors that stop a run: DWS itself refusing, throttling, failing, or not answering station after station. */
export type DwsStop = DwsRefusedError | DwsThrottledError | DwsServerError | DwsDownError;

export const isStop = (err: unknown): err is DwsStop =>
	err instanceof DwsRefusedError || err instanceof DwsThrottledError || err instanceof DwsServerError || err instanceof DwsDownError;

export type StopReason = 'refused' | 'throttled' | 'server_error' | 'unavailable';

/** Which way DWS stopped a run, as status.json records it. */
export function stopReason(err: DwsStop): StopReason {
	if (err instanceof DwsRefusedError) return 'refused';
	if (err instanceof DwsThrottledError) return 'throttled';
	if (err instanceof DwsDownError) return 'unavailable';
	return 'server_error';
}

/** The pipeline's own errors, whose names and fixed messages may leave the function (handler.ts). */
export const OWN_ERRORS = new Set([
	'DwsRefused',
	'DwsThrottled',
	'DwsServerError',
	'DwsDown',
	'DwsCoolingDown',
	'DwsUnavailable',
	'DwsFormatError',
	'StoreFormatError',
	'LeaseBusy',
	'WindowUnfinished',
	'DwsStationsFailed',
	'PipelineFailed'
]);

/** The fixed text logged for a station's failure: never the message, which is ours, but kept short and the same everywhere. */
export function failureLabel(err: unknown): string {
	if (err instanceof DwsFormatError || err instanceof DwsUnavailableError) return err.label;
	if (err instanceof StoreFormatError) return 'stored flows unreadable';
	return 'unexpected error';
}
