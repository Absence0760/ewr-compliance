// tools/breaker-reset.sh (the spend breaker's reset, infra/breaker.tf) against a fake `aws` on PATH
// that records each call and answers from a scenario: no AWS, no credentials, no real sops file.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, 'breaker-reset.sh');

// The fake CLI. Its answer is keyed by service and command, and for a few by an argument.
const FAKE_AWS = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_AWS_LOG, JSON.stringify(args) + '\\n');
const s = JSON.parse(fs.readFileSync(process.env.FAKE_AWS_SCENARIO, 'utf8'));
const words = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const key = words.slice(0, 2).join(' ');
const after = (flag) => args[args.indexOf(flag) + 1];
let answer = s[key];
if (key === 'cloudwatch describe-alarms') answer = args.includes('--alarm-names') ? s.thresholds[after('--alarm-names')] : s.alarms[after('--alarm-name-prefix')];
if (key === 'cloudwatch get-metric-statistics') answer = s.used[after('--dimensions')];
if (key === 'lambda get-function-concurrency') answer = s.concurrency[after('--function-name')];
process.stdout.write(answer === undefined ? '' : String(answer) + '\\n');
`;

type Scenario = Record<string, unknown>;

// A fake `sops`: records its profile and arguments, then "decrypts" by printing the file as it is
// (the tests' .sops files are plaintext), or fails as sops does without credentials when
// FAKE_SOPS_FAIL is set.
const FAKE_SOPS = `#!/usr/bin/env bash
printf '%s %s\\n' "\${AWS_PROFILE:-}" "$*" >> "$FAKE_SOPS_LOG"
[ -n "\${FAKE_SOPS_FAIL:-}" ] && { echo "Failed to get the data key required to decrypt the SOPS file." >&2; exit 128; }
cat "\${!#}"
`;

// A fake `terraform`: `output -raw api_reserved_concurrency` prints FAKE_TF_API, or fails as an
// uninitialised infra/ does when it is unset.
const FAKE_TERRAFORM = `#!/usr/bin/env bash
case "$*" in
	*"output -raw api_reserved_concurrency"*) [ -n "\${FAKE_TF_API:-}" ] && { printf '%s' "$FAKE_TF_API"; exit 0; } ;;
esac
echo "Error: no outputs found" >&2
exit 1
`;

// The tfvars file: `prod.tfvars` (plaintext) by default, named by EWR_TFVARS; `prod.tfvars.sops`
// likewise; `default` is the .sops file at the script's default path under HOME, with no EWR_TFVARS.
type TfvarsAt = 'prod.tfvars' | 'prod.tfvars.sops' | 'default';
const DEFAULT_TFVARS = 'github/infra-secrets/ewr-compliance/prod.tfvars.sops';

function run(scenario: Scenario, env: Record<string, string> = {}, tfvars?: string, at: TfvarsAt = 'prod.tfvars') {
	const dir = mkdtempSync(join(tmpdir(), 'breaker-reset-'));
	try {
		for (const [name, body] of [['aws', FAKE_AWS], ['terraform', FAKE_TERRAFORM], ['sops', FAKE_SOPS]]) {
			writeFileSync(join(dir, name), body);
			chmodSync(join(dir, name), 0o755);
		}
		writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario));
		const log = join(dir, 'calls.log');
		writeFileSync(log, '');
		const sopsLog = join(dir, 'sops.log');
		writeFileSync(sopsLog, '');
		const file = join(dir, at === 'default' ? DEFAULT_TFVARS : at);
		if (tfvars !== undefined) {
			mkdirSync(join(file, '..'), { recursive: true });
			writeFileSync(file, tfvars);
		}
		const before = readdirSync(dir, { recursive: true }).sort();
		const r = spawnSync('bash', [SCRIPT], {
			encoding: 'utf8',
			env: {
				PATH: `${dir}:${process.env.PATH}`,
				HOME: dir,
				AWS_PROFILE: 'test-profile',
				FAKE_AWS_LOG: log,
				FAKE_AWS_SCENARIO: join(dir, 'scenario.json'),
				FAKE_SOPS_LOG: sopsLog,
				BREAKER_RESET_REGION: 'af-south-1',
				...(at === 'default' ? {} : { EWR_TFVARS: file }),
				...env
			}
		});
		const calls: string[][] = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
		const sopsCalls = readFileSync(sopsLog, 'utf8').trim().split('\n').filter(Boolean);
		const written = readdirSync(dir, { recursive: true }).sort().filter((f) => !before.includes(f));
		return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls, sopsCalls, file, written };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const API_ALARMS = 'ewr-compliance-breaker-api-concurrency\tewr-compliance-breaker-api-duration\tewr-compliance-breaker-api-invocations';
const DWS_ALARMS = 'ewr-compliance-breaker-dws-concurrency\tewr-compliance-breaker-dws-duration\tewr-compliance-breaker-dws-invocations';

const TRIPPED: Scenario = {
	alarms: { 'ewr-compliance-breaker-api-': API_ALARMS, 'ewr-compliance-breaker-dws-': DWS_ALARMS },
	thresholds: { 'ewr-compliance-breaker-api-duration': '3600000.0', 'ewr-compliance-breaker-dws-duration': '5400000.0' },
	used: { 'Name=FunctionName,Value=ewr-compliance-api': 'None', 'Name=FunctionName,Value=ewr-compliance-dws': '120000.0' },
	concurrency: { 'ewr-compliance-api': '0', 'ewr-compliance-dws': '0' },
	'sqs get-queue-url': 'https://sqs.af-south-1.amazonaws.com/000000000000/ewr-compliance-dws-dlq',
	'sqs get-queue-attributes': '2'
};

const named = (calls: string[][], service: string, command: string) => calls.filter((c) => c.includes(service) && c.includes(command));
const arg = (c: string[], flag: string) => c[c.indexOf(flag) + 1];
const order = (calls: string[][]) => calls.map((c) => c.slice(4, 6).join(' '));

describe('tools/breaker-reset.sh', () => {
	it('re-arms every trip alarm, then reopens each stopped function to Terraform’s value', () => {
		const { status, calls, stderr, stdout } = run(TRIPPED, {}, 'api_reserved_concurrency = 5\n');
		expect(status, stderr).toBe(0);
		for (const c of calls) expect(c.slice(0, 4)).toEqual(['--profile', 'test-profile', '--region', 'af-south-1']);

		const ok = named(calls, 'cloudwatch', 'set-alarm-state');
		expect(ok.map((c) => arg(c, '--alarm-name'))).toEqual([...API_ALARMS.split('\t'), ...DWS_ALARMS.split('\t')]);
		expect(ok.every((c) => arg(c, '--state-value') === 'OK')).toBe(true);
		expect(ok.some((c) => arg(c, '--alarm-name') === 'ewr-compliance-breaker-errors')).toBe(false);

		const put = named(calls, 'lambda', 'put-function-concurrency');
		expect(put.map((c) => [arg(c, '--function-name'), arg(c, '--reserved-concurrent-executions')])).toEqual([['ewr-compliance-api', '5']]);
		const del = named(calls, 'lambda', 'delete-function-concurrency');
		expect(del.map((c) => arg(c, '--function-name'))).toEqual(['ewr-compliance-dws']);

		// Alarms first: re-armed before anything runs again.
		const o = order(calls);
		expect(o.lastIndexOf('cloudwatch set-alarm-state')).toBeLessThan(o.indexOf('lambda put-function-concurrency'));
		expect(o.lastIndexOf('cloudwatch set-alarm-state')).toBeLessThan(o.indexOf('lambda delete-function-concurrency'));

		// The DLQ's daily events are reported, never redriven.
		expect(named(calls, 'sqs', 'start-message-move-task')).toHaveLength(0);
		expect(stdout).toContain('holds 2 daily run event(s)');
	});

	it('reopens the API unreserved when the tfvars set no reservation (the account still at its first 10)', () => {
		const { status, calls } = run(TRIPPED, {}, 'site_enabled = true\n');
		expect(status).toBe(0);
		expect(named(calls, 'lambda', 'put-function-concurrency')).toHaveLength(0);
		expect(named(calls, 'lambda', 'delete-function-concurrency').map((c) => arg(c, '--function-name'))).toEqual(['ewr-compliance-api', 'ewr-compliance-dws']);
	});

	it('takes the API’s value from terraform output before the tfvars', () => {
		const { status, calls } = run(TRIPPED, { FAKE_TF_API: '7' }, 'api_reserved_concurrency = 5\n');
		expect(status).toBe(0);
		expect(named(calls, 'lambda', 'put-function-concurrency').map((c) => arg(c, '--reserved-concurrent-executions'))).toEqual(['7']);
		const none = run(TRIPPED, { FAKE_TF_API: 'none' });
		expect(named(none.calls, 'lambda', 'delete-function-concurrency').map((c) => arg(c, '--function-name'))).toEqual(['ewr-compliance-api', 'ewr-compliance-dws']);
	});

	it('refuses, changing nothing, when it can read the API’s value from nowhere, rather than leave it uncapped', () => {
		const { status, calls, stderr } = run(TRIPPED);
		expect(status).toBe(2);
		expect(stderr).toContain("Can't tell the API's reserved concurrency");
		expect(named(calls, 'cloudwatch', 'set-alarm-state')).toHaveLength(0);
		expect(calls.some((c) => c.includes('lambda'))).toBe(false);
		// The pipeline alone needs no API value.
		const dwsOnly = run({ ...TRIPPED, alarms: { 'ewr-compliance-breaker-dws-': DWS_ALARMS } });
		expect(dwsOnly.status, dwsOnly.stderr).toBe(0);
		expect(named(dwsOnly.calls, 'lambda', 'delete-function-concurrency').map((c) => arg(c, '--function-name'))).toEqual(['ewr-compliance-dws']);
	});

	it('decrypts a .sops tfvars (the default path) through sops as the profile, keeping only the number', () => {
		const tfvars = 'domain_name = "SENTINEL-not-to-be-printed"\napi_reserved_concurrency = 5\n';
		const r = run(TRIPPED, {}, tfvars, 'default');
		expect(r.status, r.stderr).toBe(0);
		expect(r.sopsCalls).toEqual([`test-profile --decrypt --input-type binary --output-type binary ${r.file}`]);
		expect(named(r.calls, 'lambda', 'put-function-concurrency').map((c) => [arg(c, '--function-name'), arg(c, '--reserved-concurrent-executions')])).toEqual([['ewr-compliance-api', '5']]);
		expect(r.stdout + r.stderr).not.toContain('SENTINEL');
		expect(r.written).toEqual([]);
	});

	it('reads a decrypted .sops tfvars without the line as unreserved', () => {
		const r = run(TRIPPED, {}, 'site_enabled = true\n', 'prod.tfvars.sops');
		expect(r.status, r.stderr).toBe(0);
		expect(r.sopsCalls).toHaveLength(1);
		expect(named(r.calls, 'lambda', 'delete-function-concurrency').map((c) => arg(c, '--function-name'))).toEqual(['ewr-compliance-api', 'ewr-compliance-dws']);
	});

	it('refuses, changing nothing, when the .sops tfvars will not decrypt, and says to log in', () => {
		const r = run(TRIPPED, { FAKE_SOPS_FAIL: '1' }, 'api_reserved_concurrency = 5\n', 'prod.tfvars.sops');
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("Can't tell the API's reserved concurrency");
		expect(r.stderr).toContain("aws sso login --profile test-profile");
		expect(r.stderr).not.toContain('Failed to get the data key');
		expect(named(r.calls, 'cloudwatch', 'set-alarm-state')).toHaveLength(0);
		expect(r.calls.some((c) => c.includes('lambda'))).toBe(false);
		// The pipeline alone needs no API value, so a failed decrypt doesn't stop it.
		const dwsOnly = run({ ...TRIPPED, alarms: { 'ewr-compliance-breaker-dws-': DWS_ALARMS } }, { FAKE_SOPS_FAIL: '1' }, 'api_reserved_concurrency = 5\n', 'prod.tfvars.sops');
		expect(dwsOnly.status, dwsOnly.stderr).toBe(0);
	});

	it('never calls sops for a plaintext tfvars, or when terraform output has the value', () => {
		expect(run(TRIPPED, {}, 'api_reserved_concurrency = 5\n').sopsCalls).toEqual([]);
		expect(run(TRIPPED, { FAKE_TF_API: '7' }, 'api_reserved_concurrency = 5\n', 'prod.tfvars.sops').sopsCalls).toEqual([]);
	});

	it('takes BREAKER_RESET_API_CONCURRENCY over the tfvars, and refuses a value that isn’t one', () => {
		const set = run(TRIPPED, { BREAKER_RESET_API_CONCURRENCY: '3' }, 'api_reserved_concurrency = 5\n');
		expect(named(set.calls, 'lambda', 'put-function-concurrency').map((c) => arg(c, '--reserved-concurrent-executions'))).toEqual(['3']);
		const bad = run(TRIPPED, { BREAKER_RESET_API_CONCURRENCY: '0' });
		expect(bad.status).toBe(2);
		expect(bad.calls).toHaveLength(0);
	});

	it('leaves a function the breaker did not stop as it is', () => {
		const { status, calls, stdout } = run({ ...TRIPPED, concurrency: { 'ewr-compliance-api': '5', 'ewr-compliance-dws': 'None' } }, { FAKE_TF_API: '5' });
		expect(status).toBe(0);
		expect(named(calls, 'lambda', 'put-function-concurrency')).toHaveLength(0);
		expect(named(calls, 'lambda', 'delete-function-concurrency')).toHaveLength(0);
		expect(stdout).toContain('ewr-compliance-dws: reserved concurrency is unreserved, not 0');
	});

	it('handles only the API when the DWS store is off, and then never looks at its queue', () => {
		const { status, calls } = run({ ...TRIPPED, alarms: { 'ewr-compliance-breaker-api-': API_ALARMS } }, { FAKE_TF_API: '5' });
		expect(status).toBe(0);
		expect(named(calls, 'cloudwatch', 'set-alarm-state')).toHaveLength(3);
		expect(calls.some((c) => c.includes('sqs'))).toBe(false);
		expect(calls.some((c) => c.includes('ewr-compliance-dws'))).toBe(false);
	});

	it('refuses while this clock hour is already over a duration trip, unless BREAKER_RESET_NOW=1', () => {
		const busy = { ...TRIPPED, used: { ...(TRIPPED.used as object), 'Name=FunctionName,Value=ewr-compliance-dws': '6000000.0' } };
		const refused = run(busy, { FAKE_TF_API: '5' });
		expect(refused.status).toBe(2);
		expect(refused.stderr).toContain('trip it again at once');
		expect(named(refused.calls, 'cloudwatch', 'set-alarm-state')).toHaveLength(0);
		expect(refused.calls.some((c) => c.includes('lambda'))).toBe(false);

		const forced = run(busy, { FAKE_TF_API: '5', BREAKER_RESET_NOW: '1' });
		expect(forced.status, forced.stderr).toBe(0);
		expect(named(forced.calls, 'cloudwatch', 'set-alarm-state')).toHaveLength(6);
	});

	it('stops before changing anything when it finds no trip alarms (wrong region or profile)', () => {
		const { status, calls, stderr } = run({ ...TRIPPED, alarms: {} });
		expect(status).toBe(1);
		expect(stderr).toContain('wrong region or profile');
		expect(calls.every((c) => c.includes('describe-alarms'))).toBe(true);
	});
});
