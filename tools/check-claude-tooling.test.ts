// tools/check-claude-tooling.mjs: on synthetic files, and on this repo's own .claude/.
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { checkFile, checkRepo, citedPaths } from './check-claude-tooling.mjs';

const exists = (p: string) => ['src/lib/ewr/parsers.ts', 'docs', 'CLAUDE.md'].includes(p);
const agent = (name: string, body = '') => `---\nname: ${name}\ndescription: Reviews things.\n---\n${body}`;

describe('check-claude-tooling', () => {
	it('passes an agent whose name is its file name and whose citations exist', () => {
		expect(checkFile('.claude/agents/x/foo.md', agent('foo', 'Reads `src/lib/ewr/parsers.ts:12` and `docs/`.'), 'agent', exists)).toEqual([]);
	});

	it('flags a missing frontmatter, description or name, and a name that is not the file name', () => {
		expect(checkFile('.claude/commands/c.md', 'no frontmatter', 'command', exists)[0].rule).toMatch(/no frontmatter/);
		expect(checkFile('.claude/commands/c.md', '---\nname: c\n---\n', 'command', exists)[0].rule).toMatch(/no description/);
		expect(checkFile('.claude/agents/foo.md', '---\ndescription: d\n---\n', 'agent', exists)[0].rule).toMatch(/no name/);
		expect(checkFile('.claude/agents/foo.md', agent('bar'), 'agent', exists)[0].rule).toMatch(/does not match/);
	});

	it('flags a template placeholder and a cited path that does not exist, with its line', () => {
		const found = checkFile('.claude/agents/foo.md', agent('foo', 'Use <CMS>.\nSee `src/lib/gone.ts`.'), 'agent', exists);
		expect(found.map((f) => f.line)).toEqual([5, 6]);
		expect(found[0].rule).toMatch(/^template placeholder/);
		expect(found[1].rule).toBe('cites `src/lib/gone.ts`, which does not exist');
	});

	it('skips patterns, the private repo, and generated or throwaway paths', () => {
		const text = 'Use `src/lib/*.ts`, `static/data/<wma>.json`, `../ewr-compliance-private/tools/build_data.py`, `static/data/index.json`, `build/index.html`, `e2e/zz-shot.spec.ts`, `pnpm test`.';
		expect(citedPaths(text)).toEqual([]);
		expect(citedPaths('Read `src/lib/ewr/parsers.ts § DAYS`, `CLAUDE.md` and `CONTRIBUTING.md § Releases and deploys`.').map((c) => c.path)).toEqual([
			'src/lib/ewr/parsers.ts',
			'CLAUDE.md',
			'CONTRIBUTING.md'
		]);
	});

	it("finds nothing wrong in this repo's own Claude tooling", () => {
		expect(checkRepo(fileURLToPath(new URL('..', import.meta.url)))).toEqual([]);
	});
});
