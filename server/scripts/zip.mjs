// A minimal, deterministic zip writer (deflate, no extra fields, a fixed 1980-01-01 timestamp), so
// the Lambda package needs no zip tool or dependency and the same files give the same bytes.
import { crc32, deflateRawSync } from 'node:zlib';

/** @param {Record<string, Buffer | Uint8Array>} files name → contents, written in name order */
export function zipSync(files) {
	const local = [];
	const central = [];
	let offset = 0;
	for (const name of Object.keys(files).sort()) {
		const data = Buffer.from(files[name]);
		const packed = deflateRawSync(data, { level: 9 });
		const nameBytes = Buffer.from(name, 'utf8');
		const crc = crc32(data) >>> 0;
		const head = Buffer.alloc(30);
		head.writeUInt32LE(0x04034b50, 0);
		head.writeUInt16LE(20, 4); // version needed
		head.writeUInt16LE(0x0800, 6); // UTF-8 names
		head.writeUInt16LE(8, 8); // deflate
		head.writeUInt16LE(0, 10); // time 00:00
		head.writeUInt16LE(0x21, 12); // date 1980-01-01
		head.writeUInt32LE(crc, 14);
		head.writeUInt32LE(packed.length, 18);
		head.writeUInt32LE(data.length, 22);
		head.writeUInt16LE(nameBytes.length, 26);
		head.writeUInt16LE(0, 28);
		local.push(head, nameBytes, packed);

		const entry = Buffer.alloc(46);
		entry.writeUInt32LE(0x02014b50, 0);
		entry.writeUInt16LE(0x0314, 4); // made by: Unix, 2.0
		entry.writeUInt16LE(20, 6);
		entry.writeUInt16LE(0x0800, 8);
		entry.writeUInt16LE(8, 10);
		entry.writeUInt16LE(0, 12);
		entry.writeUInt16LE(0x21, 14);
		entry.writeUInt32LE(crc, 16);
		entry.writeUInt32LE(packed.length, 20);
		entry.writeUInt32LE(data.length, 24);
		entry.writeUInt16LE(nameBytes.length, 28);
		entry.writeUInt32LE((0o100644 << 16) >>> 0, 38); // -rw-r--r--
		entry.writeUInt32LE(offset, 42);
		central.push(entry, nameBytes);
		offset += head.length + nameBytes.length + packed.length;
	}
	const dir = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(central.length / 2, 8);
	end.writeUInt16LE(central.length / 2, 10);
	end.writeUInt32LE(dir.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, dir, end]);
}
