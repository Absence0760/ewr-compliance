// The least a static host does: serves a folder under a path, sends a folder's address to its
// trailing slash, and answers anything else with 404.html. No clean URLs, no rewrites.
//   node e2e/support/static-host.mjs <folder> <port> <path>
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const [folder, port, prefix] = process.argv.slice(2);
const TYPES = {
	'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json'
};
const isFile = (path) => stat(path).then((s) => s.isFile(), () => false);
const isFolder = (path) => stat(path).then((s) => s.isDirectory(), () => false);

createServer(async (req, res) => {
	const path = decodeURIComponent(new URL(req.url, 'http://host').pathname);
	const send = async (file, status = 200) => {
		res.writeHead(status, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
		res.end(await readFile(file));
	};
	if (`${path}/` === prefix) {
		res.writeHead(301, { location: prefix }).end();
		return;
	}
	if (!path.startsWith(prefix)) {
		res.writeHead(404).end();
		return;
	}
	const file = join(folder, normalize(path.slice(prefix.length)));
	if (await isFile(file)) return send(file);
	if (await isFolder(file)) {
		if (path.endsWith('/')) return send(join(file, 'index.html'));
		res.writeHead(301, { location: `${path}/` }).end();
		return;
	}
	return send(join(folder, '404.html'), 404);
}).listen(Number(port));
