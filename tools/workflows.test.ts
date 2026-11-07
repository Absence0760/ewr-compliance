// What the GitHub workflows may do with server/, which inlines the private auth-kit. This repo is public:
// an artifact is downloadable by anyone for its retention, and a cache entry written on main can be
// restored by any run here, a fork PR's included. So no job that installs server/ caches its pnpm store
// or uploads an artifact, and no workflow uploads anything from server/. It sits in tools/ because
// vitest collects tests there; it reads files only.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DIR = new URL('../.github/workflows/', import.meta.url);
const WORKFLOWS = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));

/** Each job of a workflow, by name, with its text. */
export function jobs(workflow: string): { name: string; text: string }[] {
	const body = workflow.split(/^jobs:\s*$/m)[1] ?? '';
	const out: { name: string; text: string }[] = [];
	for (const line of body.split('\n')) {
		const key = /^ {2}([\w-]+):\s*$/.exec(line);
		if (key) out.push({ name: key[1], text: '' });
		else if (out.length) out[out.length - 1].text += `${line}\n`;
	}
	return out;
}

const INSTALLS_SERVER = /working-directory:\s*server\b|\bserver\/(package\.json|pnpm-lock\.yaml)|'server'/;

/** What a job does that could publish auth-kit, or nothing. */
export function leaks(job: string): string[] {
	const lines = job.split('\n').filter((l) => !/^\s*#/.test(l));
	const text = lines.join('\n');
	const out: string[] = [];
	// Each upload-artifact step, up to the next step.
	const uploads = text.split(/^\s+- /m).filter((step) => /uses:\s*actions\/upload-artifact@/.test(step));
	if (uploads.some((step) => /(^|[\s'"/])server\//m.test(step))) out.push('uploads an artifact from server/');
	if (INSTALLS_SERVER.test(text)) {
		if (/^\s+cache:\s*['"]?pnpm\b/m.test(text)) out.push('installs server/ with `cache: pnpm`');
		if (/uses:\s*actions\/cache[@/]/.test(text)) out.push('installs server/ with actions/cache');
		if (/uses:\s*actions\/upload-artifact@/.test(text)) out.push('installs server/ and uploads an artifact');
	}
	return out;
}

describe('workflows keep auth-kit out of artifacts and caches', () => {
	it('finds the workflows', () => {
		expect(WORKFLOWS).toContain('ci.yml');
		expect(WORKFLOWS).toContain('deploy-lambdas.yml');
	});

	for (const file of WORKFLOWS) {
		it(file, () => {
			const found = jobs(readFileSync(new URL(file, DIR), 'utf8')).flatMap(({ name, text }) => leaks(text).map((why) => `${name}: ${why}`));
			expect(found).toEqual([]);
		});
	}

	it('sees the jobs that install server/', () => {
		const ci = jobs(readFileSync(new URL('ci.yml', DIR), 'utf8'));
		expect(ci.filter((j) => INSTALLS_SERVER.test(j.text)).map((j) => j.name)).toContain('server');
		const deploy = jobs(readFileSync(new URL('deploy-lambdas.yml', DIR), 'utf8'));
		expect(deploy.filter((j) => INSTALLS_SERVER.test(j.text)).map((j) => j.name)).toEqual(['deploy']);
	});

	it('refuses what the deploy workflow used to do', () => {
		const build = `
    steps:
      - uses: actions/setup-node@x # v7
        with:
          cache: pnpm
          cache-dependency-path: \${{ env.PKG }}/pnpm-lock.yaml
      - name: Install
        working-directory: server
        run: pnpm install --frozen-lockfile
      - uses: actions/upload-artifact@x # v7
        with:
          path: server/dist/api.zip
`;
		expect(leaks(build)).toEqual(['uploads an artifact from server/', 'installs server/ with `cache: pnpm`', 'installs server/ and uploads an artifact']);
	});

	it('leaves a job that does not install server/ alone, and ignores comments', () => {
		const pipeline = `
      - uses: actions/setup-node@x
        with:
          cache: pnpm
      - working-directory: pipeline
        run: pnpm install
      # No cache: pnpm for server/ here.
`;
		expect(leaks(pipeline)).toEqual([]);
	});

	it('splits a workflow into its jobs', () => {
		expect(jobs('on: push\njobs:\n  a:\n    runs-on: x\n  b-c:\n    runs-on: y\n').map((j) => j.name)).toEqual(['a', 'b-c']);
	});
});

describe('the weekly dependency audit', () => {
	const audit = readFileSync(new URL('audit.yml', DIR), 'utf8');
	// Every package with its own lockfile, found rather than listed, so a new one can't be missed.
	const packages = ['.', ...readdirSync(new URL('../', import.meta.url), { withFileTypes: true })
		.filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
		.filter((d) => existsSync(new URL(`../${d.name}/pnpm-lock.yaml`, import.meta.url)))
		.map((d) => d.name)];

	it('audits every package with a lockfile', () => {
		expect(packages).toEqual(expect.arrayContaining(['.', 'server', 'pipeline']));
		const loop = /for pkg in ([^;]+); do/.exec(audit)?.[1].trim().split(/\s+/) ?? [];
		expect(loop.sort()).toEqual([...packages].sort());
	});

	it('audits server/ and pipeline/ for what ships, from their lockfiles, with nothing installed', () => {
		expect(audit).toMatch(/\*\) name=\$pkg; prod=--prod ;;/);
		expect(audit).toContain('(cd "$pkg" && pnpm audit $prod --audit-level=moderate --json)');
		const code = audit.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
		expect(code).not.toMatch(/pnpm install|AUTH_KIT_READ_TOKEN|cache:/);
	});
});

describe('the e2e failure upload', () => {
	it("uploads the folders Playwright writes to, so a failed run's traces are kept", () => {
		const config = readFileSync(new URL('../e2e/playwright.config.ts', import.meta.url), 'utf8');
		const out = /outputDir:\s*'\.\/([\w-]+)'/.exec(config)?.[1];
		const report = /outputFolder:\s*'\.\/([\w-]+)'/.exec(config)?.[1];
		expect([out, report]).toEqual(['test-results', 'playwright-report']);
		const e2e = jobs(readFileSync(new URL('ci.yml', DIR), 'utf8')).find((j) => j.name === 'e2e')?.text ?? '';
		const upload = e2e.split(/^\s+- /m).find((step) => /uses:\s*actions\/upload-artifact@/.test(step)) ?? '';
		expect(upload).toContain(`e2e/${out}/`);
		expect(upload).toContain(`e2e/${report}/`);
	});
});
