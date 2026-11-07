// The DWS store's operator tools: the station list built from gauges.json (dws-stations.mjs, uploaded
// by dws-stations.sh) and the backfill plan (dws-backfill-plan.mjs). Synthetic X0H00x stations only.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan, sastToday } from './dws-backfill-plan.mjs';
import { stationsFile } from './dws-stations.mjs';

const link = (station: string, node = 'Synthetic:n1') => ({ node, station, factor: 1, note: '' });

describe('stationsFile', () => {
	it('lists each linked river gauge once, sorted, in the pipeline’s v1 shape', () => {
		const gauges = { links: [link('X0H002'), link('X0H001'), link('X0H002', 'Synthetic:n2'), link(' x0h003 ')], records: {}, flows: [], incomplete: {} };
		expect(stationsFile(gauges, '2026-01-01T00:00:00.000Z')).toEqual({ file: { v: 1, at: '2026-01-01T00:00:00.000Z', stations: ['X0H001', 'X0H002', 'X0H003'] }, skipped: 0 });
	});

	it('leaves out what is not a river gauge, and counts it', () => {
		const r = stationsFile({ links: [link('X0H001'), link('X0R001'), link('')] }, '2026-01-01T00:00:00.000Z');
		expect(r.file.stations).toEqual(['X0H001']);
		expect(r.skipped).toBe(2);
	});

	it('refuses a gauges.json with no links', () => {
		expect(() => stationsFile({ records: {} }, '2026-01-01T00:00:00.000Z')).toThrow('no links');
	});
});

describe('dws-stations.sh', () => {
	const run = (args: string[], env: Record<string, string> = {}) =>
		spawnSync('bash', ['tools/dws-stations.sh', ...args], { encoding: 'utf8', env: { ...process.env, PATH: process.env.PATH ?? '', ...env } });
	const gaugesFile = () => {
		const dir = mkdtempSync(join(tmpdir(), 'ewr-dws-'));
		const path = join(dir, 'gauges.json');
		writeFileSync(path, JSON.stringify({ links: [link('X0H001'), link('X0H002')] }));
		return path;
	};

	it('says how many stations, never which, on a dry run', () => {
		const r = run(['--dry-run', '--gauges', gaugesFile()], { EWR_DWS_BUCKET: 'ewr-compliance-dws-000000000000' });
		expect(r.status).toBe(0);
		expect(r.stdout).toContain('would upload 2 stations to s3://ewr-compliance-dws-000000000000/config/stations.json');
		expect(r.stdout + r.stderr).not.toMatch(/X0H00/);
	});

	it("refuses another project's bucket", () => {
		const r = run(['--dry-run', '--gauges', gaugesFile()], { EWR_DWS_BUCKET: 'someone-else' });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('not this project');
	});

	// A stub `terraform` first on PATH, answering `output -json dws_bucket` as told.
	const withTerraform = (script: string) => {
		const dir = mkdtempSync(join(tmpdir(), 'ewr-tf-'));
		writeFileSync(join(dir, 'terraform'), `#!/usr/bin/env bash\n${script}\n`, { mode: 0o755 });
		return { EWR_DWS_BUCKET: '', PATH: `${dir}:${process.env.PATH ?? ''}` };
	};

	it('reads the bucket from terraform output', () => {
		const r = run(['--dry-run', '--gauges', gaugesFile()], withTerraform(`echo '"ewr-compliance-dws-000000000000"'`));
		expect(r.status).toBe(0);
		expect(r.stdout).toContain('would upload 2 stations to s3://ewr-compliance-dws-000000000000/config/stations.json');
	});

	it('does nothing, and succeeds, when the output says the store is off', () => {
		const r = run(['--gauges', gaugesFile()], withTerraform('echo null'));
		expect(r.status).toBe(0);
		expect(r.stdout).toContain('No DWS store (dws_enabled is off)');
	});

	it('fails loudly when terraform itself fails, never taking it for "no store"', () => {
		const r = run(['--gauges', gaugesFile()], withTerraform('echo "Error: the SSO session has expired" >&2; exit 1'));
		expect(r.status).toBe(1);
		expect(r.stdout).not.toContain('No DWS store');
		expect(r.stderr).toContain("Can't read 'terraform -chdir=infra output dws_bucket'");
		expect(r.stderr).toContain('the SSO session has expired');
	});

	it('fails when the output is an empty string', () => {
		const r = run(['--gauges', gaugesFile()], withTerraform(`echo '""'`));
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('is empty');
	});
});

describe('plan', () => {
	it('covers from..to in windows of the daily window’s length, newest first, the oldest cut at from', () => {
		expect(plan({ from: '2020-01-01', to: '2023-12-31', windowDays: 730 }).items).toEqual([
			{ mode: 'backfill', from: '2022-01-01', to: '2023-12-31' },
			{ mode: 'backfill', from: '2020-01-02', to: '2021-12-31' },
			{ mode: 'backfill', from: '2020-01-01', to: '2020-01-01' }
		]);
	});

	it('leaves no day out and none twice', () => {
		const items = plan({ from: '2001-03-05', to: '2026-11-06' }).items;
		const days = items.reduce((n: number, w: { from: string; to: string }) => n + (Date.parse(w.to) - Date.parse(w.from)) / 86_400_000 + 1, 0);
		expect(days).toBe((Date.parse('2026-11-06') - Date.parse('2001-03-05')) / 86_400_000 + 1);
		for (let i = 1; i < items.length; i++) expect(Date.parse(items[i - 1].from) - Date.parse(items[i].to)).toBe(86_400_000);
	});

	it.each([
		[{ from: '2020-02-30', to: '2021-01-01' }],
		[{ from: '2021-01-02', to: '2021-01-01' }],
		[{ from: '2020-01-01', to: '2021-01-01', windowDays: 0 }],
		[{ from: '2020-01-01', to: '2021-01-01', windowDays: 9000 }]
	])('refuses %j', (o) => {
		expect(() => plan(o)).toThrow();
	});

	it('names no station, so its output can go anywhere', () => {
		expect(JSON.stringify(plan({ from: '2020-01-01', to: '2021-01-01' }))).not.toMatch(/station|[A-Z]\dH\d{3}/);
	});

	it('takes today in South Africa', () => {
		expect(sastToday(Date.parse('2026-11-06T22:30:00Z'))).toBe('2026-11-07');
	});
});
