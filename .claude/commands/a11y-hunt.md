---
description: Run rounds of accessibility hunting on a screen — fan out read-only hunters, triage against WCAG 2.2 AA, compute every contrast/size claim, then fix the real violations with a guard in the same commit. The "find and kill a11y violations" loop.
argument-hint: [area — optional; e.g. "the compliance panel", "the nodes table", "the file viewer". Omit to let the command pick one.]
---

Hunt for **accessibility violations** on a screen, then fix the real ones, each verified against the WCAG threshold (computed, not eyeballed), with a guard in the same commit. Target: `$ARGUMENTS` (if empty, pick an area that hasn't been swept recently and say which before hunting).

This is the **rule-driven** sibling of `/ux-hunt`: where `ux-hunt` is judgment (layout, affordance), a11y-hunt is **measurable**: contrast ratios, target sizes, reflow, semantics and labels, held to WCAG 2.2 AA. It is the **fix side** of the read-only `/audit/accessibility` reporter: that command finds and reports, this loop fixes and guards.

**Wrong fit — do something else instead:**
- A judgment call about whether a layout is good → `/ux-hunt`.
- A correctness bug or perf problem → `/bug-hunt` / `/perf-hunt`.
- Just want a report, not fixes → `/audit/accessibility`.

## What counts as an a11y violation (the triage bar)

A finding is worth fixing when it **fails a specific WCAG 2.2 AA success criterion you can name and measure**:
- **1.4.3 Contrast (text)** — < 4.5:1 (normal) / 3:1 (large ≥ 18pt or 14pt bold).
- **1.4.11 Non-text contrast** — < 3:1 for UI component boundaries, meaningful icons, chart lines and map markers, focus indicators.
- **2.5.8 Target size** — interactive targets < 24×24 CSS px.
- **1.4.4 / 1.4.10 Resize and reflow** — content lost or clipped at 200% zoom / 320 CSS px width.
- **1.1.1 / 4.1.2 Name, role, value** — an icon-only button with no label, a chart with no text alternative, a select with no associated label.
- **2.4.7 / 2.1.x Focus and keyboard** — invisible focus, a keyboard trap, an unreachable control.

Reject, and don't burn a commit on: "feels cramped" (that's `ux-hunt`), a contrast ratio you *guessed* without computing, or a target you didn't actually measure.

## The loop

### 1. Pick the area (if `$ARGUMENTS` is empty or vague)

Choose one bounded area (a route and its components, the map, a panel) and say which and why.

### 2. Fan out read-only hunters (in parallel)

Spawn hunters in a single message: `general-purpose` agents pointed at the area's files and the tokens in `src/app.css`, each instructed to find **WCAG 2.2 AA violations** with the criterion named. Have them report, per finding: `file:line`, the criterion, the **measured value** (the two colours, the px size, the width at which it clips) and the threshold it misses. The `compliance-auditor` (via `/audit/accessibility`) is the specialist if you want a deeper single pass first. `persona-accessibility-user` gives an assistive-tech-user walkthrough.

### 3. Compute every numeric claim before touching code

This is the step that stops one violation becoming another:
- **Contrast**: compute the actual ratio from the two resolved colours (resolve the CSS variables in `src/app.css` to hex first).
- **Target size**: measure the real rendered box (padding included), not the glyph.
- **Reflow**: confirm the clip at 320 px, don't assume.
- Check whether the token is **shared**: fixing it fixes or breaks everything that uses it. The series colours in `src/lib/ewr/format.ts` were validated for colour-blind separation, so a change there is checked against that too.

### 4. Fix at the root and pin it, one fix per commit

- **Fix the root cause** at the shared token or class where there is one, not per call site, but verify the cascade first.
- **Pin it.** Add or extend a test that asserts the ratio clears AA, the target meets the minimum, or the name is present. Compute the asserted ratio in the test; don't hard-code a number you didn't derive.
- **Every violation fixed in this loop gets its guard in the same commit**, including ones found incidentally. A fix with no guard is not done; a verified but deferred violation goes to a tracked issue.

**Commit discipline (root `CLAUDE.md`):**
- Always path-scoped: `git commit -m "…" -- path1 path2 …`. `git add <new-file>` for new files only.
- One fix = one commit. `git status` before each; confirm every path is yours.
- No AI attribution or `Co-Authored-By`. Commit on your PR branch; push the branch and open a PR, **never push `main`**.

### 5. Report

A list of violations fixed (file → criterion → before value vs threshold → after value), each with its guard; what was deferred and where it's tracked; and any finding dismissed because the computed value actually passed. End with a one-line offer to hunt another area.

## Tone

- Don't narrate the fan-out.
- **Show the number.** "`--ink-3` on `--surface` = 4.9:1, passes" beats "improved contrast". Always state the computed ratio.
- Lead with the shared-token fix where one exists; name the cascade you verified.
