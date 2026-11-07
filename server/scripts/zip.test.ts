import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs build script, without types
import { zipSync } from './zip.mjs';

describe('the Lambda zip', () => {
	it('is deterministic and holds each file, deflated', () => {
		const files = { 'index.mjs': Buffer.from('export const handler = () => 1;\n'.repeat(50)) };
		const a: Buffer = zipSync(files);
		expect(zipSync(files).equals(a)).toBe(true);
		expect(a.readUInt32LE(0)).toBe(0x04034b50);
		const nameLength = a.readUInt16LE(26);
		const size = a.readUInt32LE(18);
		expect(a.subarray(30, 30 + nameLength).toString()).toBe('index.mjs');
		expect(inflateRawSync(a.subarray(30 + nameLength, 30 + nameLength + size)).equals(files['index.mjs'])).toBe(true);
		expect(a.readUInt32LE(a.length - 22)).toBe(0x06054b50);
		expect(a.readUInt16LE(a.length - 12)).toBe(1);
	});
});
