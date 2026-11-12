// tools/first-admin, recover-admin, clear-lock and erase-user: what they refuse before reaching AWS.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const run = (tool: string, args: string[], env: Record<string, string> = {}) => {
	const r = spawnSync(join(import.meta.dirname, tool), args, { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env } });
	return { status: r.status, out: r.stdout + r.stderr };
};

describe('the operator tools', () => {
	it('take no address as an argument, so it stays out of shell history', () => {
		for (const tool of ['first-admin', 'recover-admin', 'clear-lock', 'erase-user']) {
			const r = run(tool, ['someone@example.com']);
			expect(r.status).toBe(2);
			expect(r.out).toContain('the address is asked for at the prompt');
			expect(r.out).not.toContain('someone@');
		}
	});

	it('refuse an unknown command', () => {
		expect(run('auth-operator.sh', ['drop-table']).status).toBe(2);
	});

	it("refuse another project's table", () => {
		for (const tool of ['first-admin', 'clear-lock']) {
			const r = run(tool, [], { EWR_USERS_TABLE: 'water-management-users', EWR_RUNTIME_SECRET_ARN: 'arn:aws:secretsmanager:af-south-1:000000000000:secret:x' });
			expect(r.status).toBe(1);
			expect(r.out).toContain("Refusing table 'water-management-users'");
		}
	});

	// A stand-in terraform first on PATH, so the test never reaches the real one or AWS.
	const fakeTerraform = (script: string) => {
		const dir = mkdtempSync(join(tmpdir(), 'ewr-fake-tf-'));
		writeFileSync(join(dir, 'terraform'), `#!/usr/bin/env bash\n${script}\n`);
		chmodSync(join(dir, 'terraform'), 0o755);
		return `${dir}:${process.env.PATH ?? ''}`;
	};

	it("show terraform's own error when the outputs can't be read, and never send the operator to apply", () => {
		const PATH = fakeTerraform('echo \'Error: Backend initialization required, please run "terraform init"\' >&2; exit 1');
		const r = run('first-admin', [], { PATH });
		expect(r.status).toBe(1);
		expect(r.out).toContain("Can't read 'terraform -chdir=infra output users_table' with the ewr-compliance profile");
		expect(r.out).toContain('Backend initialization required');
		expect(r.out).toContain('aws sso login --profile ewr-compliance');
		expect(r.out).not.toMatch(/apply/i);
	});

	it('say so when the site has no sign-in', () => {
		const r = run('first-admin', [], { PATH: fakeTerraform('echo null') });
		expect(r.status).toBe(1);
		expect(r.out).toContain('auth_enabled is off');
	});

	it("read terraform's JSON outputs as plain names", () => {
		const r = run('first-admin', [], { PATH: fakeTerraform('echo \'"water-management-users"\'') });
		expect(r.status).toBe(1);
		expect(r.out).toContain("Refusing table 'water-management-users'");
	});
});
