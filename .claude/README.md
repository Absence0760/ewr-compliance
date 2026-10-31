# .claude/ — Claude Code tooling

Agents, commands and hooks for this repo: a static, client-only SvelteKit app
with a Python data build. Every agent names real paths and rules from
`CLAUDE.md` and `docs/`; a placeholder or a path that doesn't exist is a bug to
fix, not a template to fill in.

## How the pieces fit

Work in this repo is one GitHub issue per session, landing as one PR:

1. **Build**: `/issue <n>` reads the issue, makes the worktree and routes the
   work to the right workflow below.
2. **Gate every change**: `/check` (and `/safe-edit` where the change warrants
   it) runs the engineering agents over the diff.
3. **Sweep periodically**: `/audit/*`, `/persona`, the hunt loops, and
   `/release-readiness` before a release.

The session that owns the issue does the building; agents review, audit or
produce one well-defined artefact.

Reports go to `.claude/reviews/`, which `.claude/.gitignore` keeps out of git.

## Agents (`agents/`)

### `engineering/` — the per-change gate
- **`code-reviewer`** — reviews a diff against `CLAUDE.md` and `docs/architecture.md`. Strict CLEAN / NEEDS_CHANGES output. Read-only.
- **`test-gap-checker`** — maps each changed file to the test it should ship with, and the commands to run. Read-only.
- **`doc-hygiene-checker`** — maps a diff to the docs it should update. Read-only.
- **`ewr-reviewer`** — for changes to the parsers and flow arithmetic in `src/lib/ewr`: units, month order, the brief, and the values pinned by the sample and the private tests. Read-only.

### `design/`
- **`ui-designer`** — builds or reviews one screen. `build` mode commits on a PR branch; `review` mode is read-only.

### `audit/` — periodic sweeps, read-only
- **`repo-security-auditor`** — the browser trust boundary: uploaded files, the DOM, third-party origins, dependencies, CI, publish safety. Areas `secrets`, `xss`, `uploads`, `ci`, `public-repo`, `all`. Writes `.claude/reviews/security-<area>.md`.
- **`compliance-auditor`** — WCAG 2.2 AA, and the promise that flow files stay in the browser. Areas `accessibility`, `third-party-data-flows`, `cookie-consent`.

### `personas/` — bug-hunting points of view, read-only
Each walks the app as one kind of person and writes `.claude/reviews/<persona>.md`. Run through `/persona`; the protocol and how to add one are in `.claude/personas/README.md`.
- Generic: `new-user`, `power-user`, `accessibility-user`, `adversary`.
- Domain: `hydrologist`, `environmentalist`, `regulator`.

## Commands (`commands/`)

- **`issue.md`** — `/issue <n>`: one GitHub issue end to end.
- **`draft.md`** — `/draft`: one draft PR for an ad hoc testing session; each issue the operator sends is fixed into it, and `/draft ready` marks it ready.
- **`check.md`** — pre-commit gate: the three engineering reviewers in parallel, plus `ewr-reviewer` for the arithmetic and `ui-designer` review for screens. Advisory.
- **`safe-edit.md`** — coder, reviewer, fix, re-review, for load-bearing changes.
- **`polish-ui.md`** — runs `ui-designer`: `/polish-ui <target>` builds, `/polish-ui review <target>` reports.
- **`persona.md`** — runs one, several or all personas in parallel and consolidates.
- **`release-readiness.md`** — go/no-go before tagging a release.
- **Hunt and fix loops** (commit path-scoped, land through a PR, never push `main`): `bug-hunt`, `ux-hunt`, `perf-hunt`, `a11y-hunt`, `coverage-hunt`, `audit-and-fix`, `fix-ci`.
- **`audit/`** — focused read-only audits; index in `audit/README.md`.

## Skills (`skills/`)

- **`steward/SKILL.md`** — how a session drives a PR here to green: the `CI gate`, what docs-only PRs still run, the local command for each CI job, flakes, updating a branch that fell behind, reviews, and what to ask the operator first.

## Hooks (`hooks/`, wired in `settings.json`)

- **`git-scope-guard.py`** (PreToolUse on Bash) — blocks whole-tree git commands, any push to `main` and PR titles CI would refuse, so sessions sharing one checkout don't sweep up each other's work. Tests: `python3 .claude/hooks/git-scope-guard.test.py` (CI job `claude-tooling`).
- **`unmerged-worktree-check.sh`** (SessionStart) — warns when a branch holds commits not on `main`.

## Adding or changing an agent

- Put it in the team folder it belongs to.
- Name real paths, commands and rules, and cite where each rule lives (`CLAUDE.md` rule N, `docs/architecture.md`). Don't copy a rule's reasoning into the agent; point at the doc.
- Say whether it is read-only, and what it writes if not.
- Update this file and, if a command uses it, that command.
