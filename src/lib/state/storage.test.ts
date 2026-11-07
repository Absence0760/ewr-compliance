import { describe, expect, it } from 'vitest';
import { readStored, writeStored } from './storage.ts';

describe('readStored', () => {
	it('reads what this version keeps, and needs no rewrite', () => {
		const raw = writeStored({ ecBasis: 'REC', choices: { 'Basin:n1': { factor: 2 } } });
		expect(readStored(raw)).toEqual({ stored: { ecBasis: 'REC', choices: { 'Basin:n1': { factor: 2 } } }, migrated: false });
	});

	it('starts empty with nothing stored', () => {
		expect(readStored(null)).toEqual({ stored: {}, migrated: false });
	});

	it('drops the DWS API addresses an older version kept, keeping the rest, and asks for a rewrite', () => {
		const old = JSON.stringify({
			ecBasis: 'PES',
			choices: { 'Basin:n1': { ec: 'C' } },
			histApi: { url: 'https://example.test/monthly?s={station}', station: 'X0H001' },
			rtApi: { daily: '', readings: 'https://example.test/rt', station: 'X0H001' }
		});
		const { stored, migrated } = readStored(old);
		expect(migrated).toBe(true);
		expect(stored).toEqual({ ecBasis: 'PES', choices: { 'Basin:n1': { ec: 'C' } } });
		expect(writeStored(stored)).not.toMatch(/Api|example\.test/);
	});

	it('drops an older version that kept only an address', () => {
		expect(readStored(JSON.stringify({ rtApi: { url: 'https://example.test/rt' } }))).toEqual({ stored: {}, migrated: true });
	});

	it('leaves out what it cannot trust, and rewrites text that is not JSON', () => {
		expect(readStored(JSON.stringify({ ecBasis: 'XYZ', choices: [] })).stored).toEqual({});
		expect(readStored('{not json')).toEqual({ stored: {}, migrated: true });
		expect(readStored('[1]')).toEqual({ stored: {}, migrated: true });
	});
});
