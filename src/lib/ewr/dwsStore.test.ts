import { describe, expect, it } from 'vitest';
import { dwsEntry, dwsOffer, dwsPath, dwsStatus, dwsUnavailable, fetchedText, parseDwsIndex, type DwsState } from './dwsStore.ts';
import type { GaugeLink } from './types.ts';

const entry = { fetchedAt: '2024-11-02T04:15:00Z', covers: { from: '2024-10-01', to: '2024-10-31' }, stale: false };
const index = { version: 1, stations: { X0H001: { ...entry, monthly: true }, X0H002: { ...entry, stale: true } } };
const link = (station: string): GaugeLink => ({ node: 'Basin:n1', station, factor: 0.5, note: '' });
const ready: DwsState = { status: 'ready', index: parseDwsIndex(index) };

describe('parseDwsIndex', () => {
	it('reads each station, with monthly false when left out', () => {
		expect(parseDwsIndex(index).stations).toEqual({ X0H001: { ...entry, monthly: true }, X0H002: { ...entry, stale: true, monthly: false } });
	});

	it('reads a store that holds no station yet', () => {
		expect(parseDwsIndex({ version: 1, stations: {} }).stations).toEqual({});
	});

	it.each([
		['not an object', [], 'dws/index.json is not a JSON object.'],
		['another version', { version: 2, stations: {} }, 'dws/index.json is format version 2; this app reads 1.'],
		['no stations', { version: 1 }, 'dws/index.json has no stations.'],
		['a station with no time', { version: 1, stations: { X0H001: { ...entry, fetchedAt: 'yesterday' } } }, 'dws/index.json: X0H001 has no fetchedAt time.'],
		['a period not in days', { version: 1, stations: { X0H001: { ...entry, covers: { from: '2024-10', to: '2024-10-31' } } } }, 'dws/index.json: X0H001 has no covers period, from and to as YYYY-MM-DD.'],
		['no stale flag', { version: 1, stations: { X0H001: { fetchedAt: entry.fetchedAt, covers: entry.covers } } }, 'dws/index.json: X0H001 has no stale flag.'],
		['a monthly flag that is text', { version: 1, stations: { X0H001: { ...entry, monthly: 'yes' } } }, 'dws/index.json: X0H001 has a monthly flag that is not true or false.']
	])('refuses %s', (_, json, message) => {
		expect(() => parseDwsIndex(json)).toThrow(message);
	});
});

describe('dwsUnavailable', () => {
	it('says a 404 is a copy of the site with no store, and anything else could not be read', () => {
		expect(dwsUnavailable(404)).toEqual({ status: 'unavailable', reason: 'DWS data is not connected to this site yet. Load a file instead.' });
		expect(dwsUnavailable(500)).toEqual({ status: 'unavailable', reason: 'The DWS store could not be read: HTTP 500.' });
		expect(dwsUnavailable(null, 'Failed to fetch')).toEqual({ status: 'unavailable', reason: 'The DWS store could not be read: Failed to fetch' });
	});
});

describe('fetchedText', () => {
	it("is South Africa's time, whatever the zone of the browser", () => {
		expect(fetchedText('2024-11-02T04:15:00Z')).toBe('2 Nov 2024, 06:15 SAST');
		expect(fetchedText('2024-11-02T23:30:00Z')).toBe('3 Nov 2024, 01:30 SAST');
		expect(fetchedText('2024-09-30T21:59:00-01:00')).toBe('1 Oct 2024, 00:59 SAST');
		expect(fetchedText('2024-09-30T04:00:00Z')).toBe('30 Sep 2024, 06:00 SAST');
	});
});

describe('dwsOffer', () => {
	it('is offered only for a node with a linked gauge', () => {
		expect(dwsOffer(ready, null, 'instant').ok).toBe(false);
	});

	it('can be picked while the index is read, so a choice is not lost to a slow start', () => {
		expect(dwsOffer({ status: 'loading' }, link('X0H001'), 'instant')).toEqual({ ok: true, detail: 'Checking the store…' });
	});

	it('says why it cannot be picked: no store, or nothing for this gauge', () => {
		expect(dwsOffer(dwsUnavailable(404), link('X0H001'), 'instant')).toEqual({ ok: false, detail: 'DWS data is not connected to this site yet. Load a file instead.' });
		expect(dwsOffer(ready, link('X0H009'), 'instant')).toEqual({ ok: false, detail: 'The store holds nothing for X0H009 yet.' });
	});

	it('offers monthly volumes only where the store has them', () => {
		expect(dwsOffer(ready, link('X0H002'), 'monthly')).toEqual({ ok: false, detail: 'The store has no monthly volumes for X0H002 yet.' });
		expect(dwsOffer(ready, link('X0H001'), 'monthly')).toEqual({ ok: true, detail: 'Monthly volumes, pulled from DWS. Fetched 2 Nov 2024, 06:15 SAST.' });
	});

	it('says when it was fetched, and when it is out of date', () => {
		expect(dwsOffer(ready, link('X0H001'), 'instant').detail).toBe('Daily flow, and 12-minute readings where DWS has them, pulled from DWS. Fetched 2 Nov 2024, 06:15 SAST.');
		expect(dwsOffer(ready, link('X0H002'), 'instant')).toEqual({
			ok: true,
			detail: 'Daily flow, and 12-minute readings where DWS has them, pulled from DWS. Fetched 2 Nov 2024, 06:15 SAST, and out of date.'
		});
	});
});

describe('dwsEntry and dwsStatus', () => {
	it("is the entry for the node's gauge, once the index is read", () => {
		expect(dwsEntry(ready, link('X0H001'))).toEqual({ ...entry, monthly: true });
		expect(dwsEntry(ready, link('X0H009'))).toBeNull();
		expect(dwsEntry(ready, null)).toBeNull();
		expect(dwsEntry({ status: 'loading' }, link('X0H001'))).toBeNull();
	});

	it('says what the copy covers, or that it is out of date and how far it goes', () => {
		expect(dwsStatus('X0H001', { ...entry, monthly: true })).toEqual({
			stale: false,
			text: 'Fetched 2 Nov 2024, 06:15 SAST, with daily flow from 2024-10-01 to 2024-10-31.'
		});
		expect(dwsStatus('X0H002', { ...entry, stale: true, monthly: false })).toEqual({
			stale: true,
			text: "Out of date: the store's pulls of X0H002 have stopped keeping it current. Last fetched 2 Nov 2024, 06:15 SAST, with daily flow to 2024-10-31."
		});
	});
});

describe('dwsPath', () => {
	it('is under dws/, with no leading slash, and the station made safe for a path', () => {
		expect(dwsPath.index).toBe('dws/index.json');
		expect(dwsPath.flows('X0H001')).toBe('dws/flows-X0H001.json');
		expect(dwsPath.monthly('X0H001')).toBe('dws/monthly-X0H001.json');
		expect(dwsPath.flows('../x')).toBe('dws/flows-..%2Fx.json');
	});
});
