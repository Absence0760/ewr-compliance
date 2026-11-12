import { describe, expect, it } from 'vitest';
import { parseKml } from './kml.ts';

// Every KML here is synthetic: invented codes, rivers and points.
const kml = (body: string, open = '<kml xmlns="http://www.opengis.net/kml/2.2">', close = '</kml>') =>
	`<?xml version="1.0" encoding="UTF-8"?>\n${open}\n<Document>\n<name>Sample nodes</name>\n${body}\n</Document>\n${close}\n`;

const point = (lon: number, lat: number) => `<Point><coordinates>${lon},${lat},0</coordinates></Point>`;

describe('parseKml', () => {
	it('reads SimpleData, the folder and the point, as the supplied node KMLs carry them', () => {
		const { placemarks, skipped } = parseKml(
			kml(`<Schema name="nodes" id="nodes"><SimpleField type="string" name="NODE"></SimpleField></Schema>
<Folder><name>Sample folder</name>
	<Placemark>
		<ExtendedData><SchemaData schemaUrl="#nodes">
			<SimpleData name="NODE">Syx1</SimpleData>
			<SimpleData name="RIVER">  Sample River </SimpleData>
			<SimpleData name="PES">C</SimpleData>
		</SchemaData></ExtendedData>
		${point(19.25, -33.5)}
	</Placemark>
</Folder>`)
		);
		expect(skipped).toEqual([]);
		expect(placemarks).toEqual([{ name: '', lon: 19.25, lat: -33.5, folder: 'Sample folder', data: { NODE: 'Syx1', RIVER: 'Sample River', PES: 'C' } }]);
	});

	it('reads Data with a value, and the placemark name', () => {
		const { placemarks } = parseKml(
			kml(`<Placemark><name> syy2 </name>
	<ExtendedData><Data name="COMMENT"><displayName>Comment</displayName><value>At the sample weir</value></Data></ExtendedData>
	${point(20, -34)}
</Placemark>`)
		);
		expect(placemarks).toEqual([{ name: 'syy2', lon: 20, lat: -34, folder: null, data: { COMMENT: 'At the sample weir' } }]);
	});

	it('keeps the nearest named folder, and an unnamed folder inherits it', () => {
		const { placemarks } = parseKml(
			kml(`<Folder><name>Outer</name>
	<Folder><Placemark><name>syx1</name>${point(1, 2)}</Placemark></Folder>
	<Folder><name>Inner</name><Placemark><name>syx2</name>${point(3, 4)}</Placemark></Folder>
</Folder>
<Placemark><name>syx3</name>${point(5, 6)}</Placemark>`)
		);
		expect(placemarks.map((p) => [p.name, p.folder])).toEqual([
			['syx1', 'Outer'],
			['syx2', 'Inner'],
			['syx3', null]
		]);
	});

	it('reads CDATA and decodes entities, in text and in attributes', () => {
		const { placemarks } = parseKml(
			kml(`<Placemark><name><![CDATA[syx1 <main>]]></name>
	<ExtendedData><Data name="R&amp;D"><value>Sample &amp; River &#8211; &#x41;&lt;</value></Data>
	<SchemaData><SimpleData name="NOTE"><![CDATA[a & b]]></SimpleData></SchemaData></ExtendedData>
	${point(1, 2)}
</Placemark>`)
		);
		expect(placemarks[0].name).toBe('syx1 <main>');
		expect(placemarks[0].data).toEqual({ NOTE: 'a & b', 'R&D': 'Sample & River – A<' });
	});

	it('reads tags with a kml: prefix, comments, and coordinates spread over whitespace', () => {
		const text = `<?xml version="1.0"?>
<!-- an exported sample -->
<kml:kml xmlns:kml="http://www.opengis.net/kml/2.2"><kml:Document>
	<kml:Placemark><kml:name>syx1</kml:name>
		<kml:Point><kml:coordinates>
			19.5 , -33.25 , 12
		</kml:coordinates></kml:Point>
	</kml:Placemark>
</kml:Document></kml:kml>`;
		const { placemarks } = parseKml(text);
		expect(placemarks).toEqual([{ name: 'syx1', lon: 19.5, lat: -33.25, folder: null, data: {} }]);
	});

	it("takes a MultiGeometry's first point", () => {
		const { placemarks } = parseKml(
			kml(`<Placemark><name>syx1</name><MultiGeometry><LineString><coordinates>0,0 1,1</coordinates></LineString>${point(7, 8)}${point(9, 10)}</MultiGeometry></Placemark>`)
		);
		expect(placemarks.map((p) => [p.lon, p.lat])).toEqual([[7, 8]]);
	});

	it('skips polygons, lines and placemarks with no point, saying why', () => {
		const { placemarks, skipped } = parseKml(
			kml(`<Folder><name>Areas</name>
	<Placemark><name>Sample area</name><Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 1,0 1,1 0,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
</Folder>
<Placemark><name>Sample reach</name><LineString><coordinates>0,0 1,1</coordinates></LineString></Placemark>
<Placemark><name>Nowhere</name></Placemark>
<Placemark><name>Off the globe</name>${point(200, 1)}</Placemark>
<Placemark><name>syx1</name>${point(1, 1)}</Placemark>`)
		);
		expect(placemarks.map((p) => p.name)).toEqual(['syx1']);
		expect(skipped).toEqual([
			{ name: 'Sample area', folder: 'Areas', reason: 'It is a polygon, not a point.' },
			{ name: 'Sample reach', folder: null, reason: 'It is a line, not a point.' },
			{ name: 'Nowhere', folder: null, reason: 'It has no point.' },
			{ name: 'Off the globe', folder: null, reason: 'Its coordinates are not a longitude and latitude.' }
		]);
	});

	it('reads a KML with no placemarks as empty', () => {
		expect(parseKml(kml(''))).toEqual({ placemarks: [], skipped: [] });
	});

	it('refuses what is not KML, saying why', () => {
		expect(() => parseKml('<?xml version="1.0"?><gpx><wpt lat="1" lon="2"/></gpx>')).toThrow('its root element is <gpx>, not <kml>');
		expect(() => parseKml('Node,Lon,Lat\nsyx1,19,-33\n')).toThrow('This is not a KML file');
		expect(() => parseKml('')).toThrow('This is not a KML file: it has no XML in it.');
		expect(() => parseKml('PK\u0003\u0004binary')).toThrow('Unzip it');
		expect(() => parseKml(kml('<Placemark><name>syx1</Placemark>'))).toThrow('</Placemark> does not close the element open there');
		expect(() => parseKml('<kml><Document>')).toThrow('<Document> is never closed');
		expect(() => parseKml('<kml/><kml/>')).toThrow('more than one root element');
	});
});
