# Persona audits

A **persona** is a read-only Claude subagent (`.claude/agents/personas/persona-*.md`) that
adopts a specific real-world point of view — a first-time visitor, a hydrologist,
a regulator, an attacker — and walks the app the way that person would, looking
for bugs, missing primitives, wrong assumptions, and gaps that a generic code
review never surfaces because it has no human stake.

Personas complement, not replace, the other reviewers:

- `code-reviewer` / `repo-security-auditor` ask *"is this code correct and safe?"*
- A persona asks *"does this app actually work for **me**, and would it embarrass
  me, mislead me, leak my data or let me cheat it?"*

## How to run one

These are agents. Run one by asking for it by name, e.g.

> run the `persona-new-user` audit
> run `persona-hydrologist` and `persona-adversary`

or run the whole panel with the `/persona` command. Each persona writes its
findings to `.claude/reviews/<persona-name>.md` (git-ignored by `.claude/.gitignore`).

## The output contract (every persona follows this)

### 1. Reconcile with reality *before* writing anything

This is the rule that keeps the reports trustworthy. On every run, a persona:

1. Captures the current commit: `git rev-parse --short HEAD`.
2. Reads its existing `.claude/reviews/<persona>.md` if one exists.
3. **Re-verifies every open finding against the code at HEAD.** For each one:
   - Still reproduces → keep it, refresh the `file:line` (line numbers drift).
   - Fixed since last run → move it to `## Resolved`, stamp the commit/date the
     fix landed (or "fixed by HEAD" if you can't pin it).
   - No longer applicable (feature removed, assumption changed) → delete it with
     a one-line note in `## Resolved` so the next run doesn't re-derive it.
4. Looks for *new* findings.
5. Rewrites the header stamp (commit + UTC date from `date -u`).

A finding asserted but not re-verified against current code is a bug in the
report. Stale findings are worse than none — they waste a fix cycle and erode
trust in the whole folder. **Never** copy a prior finding forward without opening
the file it cites.

This rule binds *any* session that touches a `.claude/reviews/*.md` file, not just the
persona agent — if you open one to act on a finding, confirm it still
reproduces at HEAD first.

### 2. File format

````markdown
---
persona: persona-new-user
last_reviewed_commit: 1a2b3c4
last_reviewed_at: 2026-01-01T00:00:00Z
---

> **Living document — reconcile before you trust.** Findings were verified at
> the commit above. Before acting on or citing any entry, re-verify it against
> the current code; a fix may have landed since. When you edit this file, follow
> the protocol in `.claude/personas/README.md` § "Reconcile with reality".

# persona-new-user — review

_One paragraph: who I am and what I came here to check._

## Open findings

### [High] path/to/file:42 — a loaded flow file fails with no message
- **What I tried:** <concrete steps or click path>
- **What I expected:** <the correct behaviour>
- **What happened:** <the bug>
- **Why it matters to me (the persona):** <the human stake>
- **Invariant / rule:** <CLAUDE.md § ... if applicable>
- **Fix scope:** <file(s) that would change — I do not patch>

## Resolved
- [Med] ~~auth.ts:88 — ...~~ fixed by `abc1234` (2026-01-01).

## Out of scope / notes
- <assumptions, things I deliberately didn't test, follow-ups>
````

### 3. Severity rubric

- **Critical** — a user's data leaves the browser, or the app reports a river as
  compliant when it isn't. Fix before the next release.
- **High** — the persona cannot complete a core job, or the app shows a
  wrong-but-plausible result they'd act on.
- **Medium** — friction, a missing affordance, a defensible-but-wrong default.
- **Low** — cosmetic, wording, nice-to-have.

### 4. House rules

- **Read-only on app code.** A persona reports; it does not patch. The only file
  it writes is its own `.claude/reviews/<persona>.md`.
- No emojis in anything you write.
- Don't paste secrets or personal data into a report; identify the field by name
  and location.
- Prefer reproducible findings. If you can't confirm one, file it under "needs
  verification" and say exactly what you'd need.
- Distinguish *a real bug* from *a feature the app never claimed to have*. Both
  are worth recording, but label the second as a **gap**, not a **defect**.

## The panel

| Persona | Point of view |
|---|---|
| `persona-new-user` | First visit: the empty panel, loading a file, error clarity, "what do I do now" |
| `persona-power-user` | Daily heavy user: many nodes, long records, large files, keyboard, speed |
| `persona-accessibility-user` | WCAG, keyboard, screen reader, contrast, motion, small screens |
| `persona-adversary` | Attacker: crafted files, DOM injection, data leaving the browser, misleading results |
| `persona-hydrologist` | Primary user: units, month order, percentiles, file parsing, beats the workbook? |
| `persona-environmentalist` | River NGO or ecologist: failures shown honestly, defaults that flatter compliance |
| `persona-regulator` | Reserve compliance officer: traceability, reproducibility, whether a result can be defended |

## The domain personas

`persona-hydrologist`, `persona-environmentalist` and `persona-regulator` test two
things: **is there a need** (would this person adopt the app over what they use
today?) and **does it work properly for them**. Each adds a `## Need verdict`
section (Adopt / Adopt if… / Would not adopt, the three things that would change
it, what they use today) above `## Open findings`.

## How a persona exercises the app

- From the code, first. `pnpm test` is safe to run.
- For a real walk, the operator's `pnpm dev` or `pnpm preview` on port 7790. If
  nothing is listening, say so in the report and work from the code.
- Throwaway scripts go under `$(mktemp -d)`. They may run the parsers against
  `static/data` through vitest.
- Test files are synthetic. Real files stay out of this repo: `pnpm data:private` copies them to `static/data`, ignored by git, for a local run.

## Adding a persona

Copy the closest `persona-*.md`, then:

1. Rewrite the frontmatter `name` (`persona-<slug>`) and `description`.
2. Rewrite the identity paragraph and the "what I care about" list in that
   persona's real voice and incentives.
3. List the concrete app surfaces this persona exercises, with file starting
   points, so the agent doesn't burn a turn rediscovering the layout.
4. Add a "known bug shapes" list: the failure modes this persona is uniquely
   positioned to catch.
5. Keep the output-contract pointer (this file). Don't restate the protocol inline.
