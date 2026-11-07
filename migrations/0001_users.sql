-- Who may use the site, and a record of every change to that. Applied once, by hand:
--   pnpm wrangler d1 execute ewr-compliance-users --remote --file migrations/0001_users.sql
-- Email addresses are kept trimmed and lowercase, as functions/lib/users.ts normalEmail makes them, and
-- the table refuses any other: a mixed-case address typed in by hand would never match a sign-in.
CREATE TABLE IF NOT EXISTS users (
	email TEXT PRIMARY KEY CHECK (email = lower(trim(email)) AND email LIKE '%_@_%'),
	admin INTEGER NOT NULL DEFAULT 0 CHECK (admin IN (0, 1)),
	added_by TEXT NOT NULL,
	added_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	at TEXT NOT NULL,
	actor TEXT NOT NULL,
	action TEXT NOT NULL,
	target TEXT NOT NULL
);
