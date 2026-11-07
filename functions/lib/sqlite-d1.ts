// Just enough of D1's interface, over Node's own SQLite, to run d1.ts's SQL in tests. A batch runs in
// one transaction, as D1's does, and is rolled back whole if any statement fails.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

type Arg = string | number | null;

export function testDb(): D1Database & { raw: DatabaseSync } {
	const db = new DatabaseSync(':memory:');
	db.exec(readFileSync(fileURLToPath(new URL('../../migrations/0001_users.sql', import.meta.url).href), 'utf8'));
	const prepare = (sql: string) => {
		let args: Arg[] = [];
		const s = {
			bind: (...a: Arg[]) => ((args = a), s),
			first: async () => db.prepare(sql).get(...args) ?? null,
			all: async () => ({ results: db.prepare(sql).all(...args) }),
			run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } })
		};
		return s;
	};
	async function batch(stmts: { run: () => Promise<unknown> }[]) {
		db.exec('BEGIN');
		try {
			const out = [];
			for (const s of stmts) out.push(await s.run());
			db.exec('COMMIT');
			return out;
		} catch (e) {
			db.exec('ROLLBACK');
			throw e;
		}
	}
	return { prepare, batch, raw: db } as unknown as D1Database & { raw: DatabaseSync };
}

export const auditRows = (d1: D1Database & { raw: DatabaseSync }) => d1.raw.prepare('SELECT actor, action, target FROM audit ORDER BY id').all();
