// tools/first-admin, recover-admin, clear-lock and erase-user: what they refuse before reaching AWS.
import { spawnSync } from 'node:child_process';
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
});
