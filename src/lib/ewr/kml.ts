// A node KML read into its placemarks, for an admin's upload (#17). Pure string parsing, no DOM, so it
// runs in the browser and in the Node tests alike. It reads what the private repo's build reads
// (`kml()` in tools/build_data.py): each placemark's name, the folder it is in, its ExtendedData and the
// first point of its geometry. A placemark with no point (a line or a polygon) is listed as skipped.

/** One point placemark. `folder` is the name of the nearest enclosing Folder that has one. */
export interface Placemark {
	name: string;
	lon: number;
	lat: number;
	folder: string | null;
	/** ExtendedData by field name: `<SimpleData name>` and `<Data name><value>`, each trimmed. */
	data: Record<string, string>;
}

/** A placemark left out, and why. */
export interface KmlSkip {
	name: string;
	folder: string | null;
	reason: string;
}

export interface ParsedKml {
	placemarks: Placemark[];
	skipped: KmlSkip[];
}

interface XmlElement {
	/** The local name: a `kml:` or any other prefix is dropped. */
	name: string;
	/** Attributes by local name, their values decoded. */
	attrs: Record<string, string>;
	children: XmlNode[];
}
type XmlNode = XmlElement | string;

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
		if (ref[0] !== '#') return ENTITIES[ref] ?? whole;
		const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
		return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
	});
}

const localName = (qname: string) => qname.slice(qname.indexOf(':') + 1);

/** The document's root element. Throws when the text is not well-formed XML. */
function parseXml(text: string): XmlElement {
	const root: XmlElement = { name: '', attrs: {}, children: [] };
	const stack: { el: XmlElement; qname: string }[] = [{ el: root, qname: '' }];
	const top = () => stack[stack.length - 1].el;
	const fail = (what: string): never => {
		throw new Error(`This is not a KML file: ${what}.`);
	};
	let i = 0;
	while (i < text.length) {
		const lt = text.indexOf('<', i);
		const end = lt === -1 ? text.length : lt;
		if (end > i) {
			const chunk = text.slice(i, end);
			if (stack.length > 1) top().children.push(decode(chunk));
			else if (chunk.trim()) fail('it has text outside its root element');
		}
		if (lt === -1) break;
		const close = (marker: string, from: number) => {
			const at = text.indexOf(marker, from);
			if (at === -1) fail(`a ${text.slice(lt, lt + 9)} is never closed`);
			return at;
		};
		if (text.startsWith('<!--', lt)) {
			i = close('-->', lt + 4) + 3;
		} else if (text.startsWith('<![CDATA[', lt)) {
			const at = close(']]>', lt + 9);
			if (stack.length === 1) fail('it has text outside its root element');
			top().children.push(text.slice(lt + 9, at));
			i = at + 3;
		} else if (text.startsWith('<?', lt)) {
			i = close('?>', lt + 2) + 2;
		} else if (text.startsWith('<!', lt)) {
			i = close('>', lt + 2) + 1;
		} else if (text.startsWith('</', lt)) {
			const at = close('>', lt + 2);
			const qname = text.slice(lt + 2, at).trim();
			if (stack.length === 1 || stack[stack.length - 1].qname !== qname) fail(`</${qname}> does not close the element open there`);
			stack.pop();
			i = at + 1;
		} else {
			// An opening tag. A '>' inside a quoted attribute value does not end it.
			let j = lt + 1;
			let quote = '';
			for (; j < text.length; j++) {
				const c = text[j];
				if (quote) {
					if (c === quote) quote = '';
				} else if (c === '"' || c === "'") quote = c;
				else if (c === '>') break;
			}
			if (j >= text.length) fail('a tag is never closed');
			const body = text.slice(lt + 1, j);
			const selfClosing = body.endsWith('/');
			const qname = /^[^\s/>]+/.exec(body)?.[0];
			if (!qname) fail('it has a tag with no name');
			if (stack.length === 1 && root.children.length) fail('it has more than one root element');
			const attrs: Record<string, string> = {};
			for (const m of body.slice((qname as string).length).matchAll(/([^\s=/]+)\s*=\s*("[^"]*"|'[^']*')/g)) attrs[localName(m[1])] = decode(m[2].slice(1, -1));
			const el: XmlElement = { name: localName(qname as string), attrs, children: [] };
			top().children.push(el);
			if (!selfClosing) stack.push({ el, qname: qname as string });
			i = j + 1;
		}
	}
	if (stack.length > 1) fail(`<${stack[stack.length - 1].qname}> is never closed`);
	const el = root.children.find((c): c is XmlElement => typeof c !== 'string');
	if (!el) fail('it has no XML in it');
	return el as XmlElement;
}

const elements = (el: XmlElement) => el.children.filter((c): c is XmlElement => typeof c !== 'string');
const child = (el: XmlElement, name: string) => elements(el).find((c) => c.name === name);
const textOf = (el: XmlElement): string => el.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');

/** Every descendant of `el` named `name`, in document order. */
function* descendants(el: XmlElement, name: string): Generator<XmlElement> {
	for (const c of elements(el)) {
		if (c.name === name) yield c;
		yield* descendants(c, name);
	}
}

const first = (el: XmlElement, name: string): XmlElement | undefined => descendants(el, name).next().value ?? undefined;

/** Why a placemark has no point: the geometry it has instead. */
function noPoint(pm: XmlElement): string {
	for (const [tag, what] of [
		['Polygon', 'a polygon'],
		['LineString', 'a line'],
		['LinearRing', 'a ring'],
		['Track', 'a track'],
		['Model', 'a 3D model']
	]) {
		if (first(pm, tag)) return `It is ${what}, not a point.`;
	}
	return 'It has no point.';
}

/**
 * A node KML's point placemarks. Throws, saying why, when the text is not KML (another XML file, a
 * zipped KMZ, a spreadsheet): a file that fails is refused whole, never half-read.
 */
export function parseKml(text: string): ParsedKml {
	if (text.startsWith('PK\u0003\u0004')) throw new Error('This is a KMZ, a zipped KML. Unzip it and load the .kml inside.');
	const root = parseXml(text.replace(/^﻿/, ''));
	if (root.name !== 'kml') throw new Error(`This is not a KML file: its root element is <${root.name}>, not <kml>.`);

	const placemarks: Placemark[] = [];
	const skipped: KmlSkip[] = [];
	const walk = (el: XmlElement, folder: string | null) => {
		for (const ch of elements(el)) {
			if (ch.name === 'Folder') {
				const nm = child(ch, 'name');
				walk(ch, nm ? textOf(nm).trim() || null : folder);
			} else if (ch.name === 'Placemark') {
				const nm = child(ch, 'name');
				const name = nm ? textOf(nm).trim() : '';
				const point = first(ch, 'Point');
				const coords = point && first(point, 'coordinates');
				if (!coords) {
					skipped.push({ name, folder, reason: noPoint(ch) });
					continue;
				}
				// lon,lat[,alt], tuples apart by whitespace; a point has one. Space around a comma is tolerated, as the build's float() does.
				const [lon, lat] = textOf(coords).trim().replace(/\s*,\s*/g, ',').split(/\s+/)[0].split(',').map((v) => (v.trim() ? Number(v) : NaN));
				if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) {
					skipped.push({ name, folder, reason: 'Its coordinates are not a longitude and latitude.' });
					continue;
				}
				const data: Record<string, string> = {};
				for (const sd of descendants(ch, 'SimpleData')) {
					const key = sd.attrs.name;
					if (key) data[key] = textOf(sd).trim();
				}
				for (const d of descendants(ch, 'Data')) {
					const key = d.attrs.name;
					const value = child(d, 'value');
					if (key) data[key] = value ? textOf(value).trim() : '';
				}
				placemarks.push({ name, lon, lat, folder, data });
			} else {
				walk(ch, folder);
			}
		}
	};
	walk(root, null);
	return { placemarks, skipped };
}
