// The spend breaker's function (infra/functions/breaker/index.mjs) with a fake PutFunctionConcurrency:
// no SDK, no AWS.
import { describe, expect, it } from 'vitest';
import { alarmsIn, createBreaker, functionsToStop, protectedFunctions } from '../infra/functions/breaker/index.mjs';

const PROTECTED = JSON.stringify({ 'ewr-compliance-breaker-api-': 'ewr-compliance-api', 'ewr-compliance-breaker-dws-': 'ewr-compliance-dws' });
const sns = (...messages: unknown[]) => ({ Records: messages.map((m) => ({ Sns: { Message: typeof m === 'string' ? m : JSON.stringify(m) } })) });
const alarm = (name: string, state = 'ALARM') => ({ AlarmName: name, NewStateValue: state, OldStateValue: 'OK' });

function fake(env: Record<string, string | undefined> = { PROTECTED }, fail: string[] = []) {
	const calls: [string, number][] = [];
	const lines: Record<string, unknown>[] = [];
	const breaker = createBreaker({
		putConcurrency: async (name: string, n: number) => {
			if (fail.includes(name)) throw new Error('AccessDenied');
			calls.push([name, n]);
		},
		log: (line: string) => lines.push(JSON.parse(line)),
		env
	});
	return { breaker, calls, lines };
}

describe('the spend breaker', () => {
	it('stops only the function whose trip alarm fired, and logs it', async () => {
		const { breaker, calls, lines } = fake();
		expect(await breaker(sns(alarm('ewr-compliance-breaker-dws-duration')))).toEqual({ stopped: ['ewr-compliance-dws'] });
		expect(calls).toEqual([['ewr-compliance-dws', 0]]);
		expect(lines).toEqual([
			{ event: 'breaker.tripped', function: 'ewr-compliance-dws', reservedConcurrency: 0, alarms: [{ alarm: 'ewr-compliance-breaker-dws-duration', state: 'ALARM' }] }
		]);
		const api = fake();
		await api.breaker(sns(alarm('ewr-compliance-breaker-api-invocations')));
		expect(api.calls).toEqual([['ewr-compliance-api', 0]]);
	});

	it('does nothing on an OK or INSUFFICIENT_DATA notification', async () => {
		const { breaker, calls, lines } = fake();
		expect(await breaker(sns(alarm('ewr-compliance-breaker-api-duration', 'OK'), alarm('ewr-compliance-breaker-dws-duration', 'INSUFFICIENT_DATA')))).toEqual({ stopped: [] });
		expect(calls).toEqual([]);
		expect(lines[0].event).toBe('breaker.ignored');
	});

	it('fails towards stopping: an unreadable message, an empty event or an unknown alarm stops every protected function', async () => {
		for (const event of [sns('not json'), sns({ Unexpected: true }), {}, undefined, sns(alarm('someone-else')), sns(alarm('a', 'OK'), alarm('b'))]) {
			const { breaker, calls } = fake();
			expect(await breaker(event)).toEqual({ stopped: ['ewr-compliance-api', 'ewr-compliance-dws'] });
			expect(calls).toEqual([
				['ewr-compliance-api', 0],
				['ewr-compliance-dws', 0]
			]);
		}
	});

	it('protects only what PROTECTED names (the DWS store off)', async () => {
		const { breaker, calls } = fake({ PROTECTED: JSON.stringify({ 'ewr-compliance-breaker-api-': 'ewr-compliance-api' }) });
		await breaker(sns('garbage'));
		expect(calls).toEqual([['ewr-compliance-api', 0]]);
	});

	it('refuses to run without a protected map, rather than guess', async () => {
		for (const raw of [undefined, '', '{', '{}', '[]', '{"p":""}']) {
			const { breaker } = fake({ PROTECTED: raw });
			await expect(breaker(sns(alarm('ewr-compliance-breaker-api-duration')))).rejects.toThrow(/PROTECTED/);
		}
	});

	it('tries every function before it reports a refused one (Lambda retries; breaker-errors mails)', async () => {
		const { breaker, calls } = fake({ PROTECTED }, ['ewr-compliance-api']);
		await expect(breaker(sns('garbage'))).rejects.toThrow(/ewr-compliance-api: AccessDenied/);
		expect(calls).toEqual([['ewr-compliance-dws', 0]]);
	});

	it('alarmsIn, protectedFunctions and functionsToStop', () => {
		expect(alarmsIn(sns(alarm('x')))).toEqual([{ alarm: 'x', state: 'ALARM' }]);
		expect(alarmsIn(sns('{'))).toEqual([{ alarm: null, state: null }]);
		const entries = protectedFunctions(PROTECTED);
		expect(entries).toHaveLength(2);
		expect(functionsToStop([], entries)).toEqual(['ewr-compliance-api', 'ewr-compliance-dws']);
		expect(functionsToStop([{ alarm: 'x', state: 'OK' }], entries)).toEqual([]);
		expect(functionsToStop([{ alarm: 'ewr-compliance-breaker-api-duration', state: 'ALARM' }, { alarm: 'ewr-compliance-breaker-api-concurrency', state: 'ALARM' }], entries)).toEqual(['ewr-compliance-api']);
	});
});
