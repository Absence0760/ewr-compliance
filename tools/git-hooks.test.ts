// tools/git-hooks.mjs, run by `prepare` on every pnpm install, and the hooks it points git at.
import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { decide, HOOKS_PATH } from './git-hooks.mjs';

describe('git hooks', () => {
	it("sets core.hooksPath when unset, keeps it when ours, leaves anyone else's, skips CI", () => {
		expect(decide(null, false)).toBe('set');
		expect(decide(HOOKS_PATH, false)).toBe('already');
		expect(decide('/home/me/hooks', false)).toBe('foreign');
		expect(decide(null, true)).toBe('skip-ci');
	});

	it('is what pnpm install runs', () => {
		const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
		expect(pkg.scripts.prepare).toBe('node tools/git-hooks.mjs');
	});

	it('runs the client terms guard on staged changes and on the message, from executable hooks', () => {
		for (const [hook, args] of [
			['pre-commit', '--staged'],
			['commit-msg', '--message "$1"']
		]) {
			const path = `${HOOKS_PATH}/${hook}`;
			expect(readFileSync(path, 'utf8')).toContain(`node tools/check-client-terms.mjs ${args}`);
			expect(statSync(path).mode & 0o111, `${path} is executable`).not.toBe(0);
		}
	});
});
