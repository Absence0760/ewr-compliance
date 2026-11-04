---
description: Hunt for real performance problems — long parses on the main thread, oversized data loads, render thrash, chart and map cost at scale — measure each before and after, fix the root cause, and guard with a test where it fits. Commits scoped; lands through a PR, never pushes `main`.
argument-hint: "[optional scope — a screen, parser, or path, e.g. a 12-minute flow file, the map first load; omit to profile the hot paths]"
---

Find performance problems that **actually bite at realistic scale** and fix them at the root. The discipline that separates this from premature optimization: **measure before you touch anything, and measure again after**. A fix with no before/after number is a guess.

`$ARGUMENTS` is an optional scope. If empty, profile the hot paths (step 1).

## Operating rules (root `CLAUDE.md`)

- **Measure first, measure after.** Timed runs at realistic row counts, bytes over the wire, a browser trace or `performance` marks. Report the before→after delta. No measurement, no claim.
- **Correctness is not negotiable for speed.** A faster path gives identical numbers: diff the output before and after on the same input, from the sample or, for real scale, `pnpm data:private`.
- **Fix the root cause, not the symptom.** Don't paper over a slow path with a cache that then needs invalidation, unless caching genuinely is the right answer.
- **Prove the scale matters.** State the n at which the problem bites. Skip changes that only help at sizes the app never sees.
- **Docs-as-code; commit scoped; PRs only, never push `main`.** No new dependency for speed without saying why.

## Where the cost usually lives

- **The first load.** The real `static/data` is 21 MB across basins, so what loads when matters: `index.json` first, a WMA's rivers (`static/geo`, up to 3 MB for Vaal-Orange) with its map, a basin's files on demand. Check the compression a static host gives, and bytes per node.
- **Large flow files.** Years of 12-minute readings are hundreds of thousands of rows through `parseDelimited`, `seriesPoints` and `monthlyFromPoints`, on the main thread. SheetJS adds the workbook parse.
- **Recomputation.** A `$derived` over a whole record that reruns on every selection change or keystroke.
- **Chart and map.** uPlot with every instantaneous point; MapLibre layers rebuilt rather than updated.
- **Repeated work in a loop.** A regex compiled per row, a whole store reparsed per node, `parseTab` run again for each file when a cached result would do.
- **The bundle.** MapLibre and SheetJS are heavy; SheetJS only matters to someone loading a spreadsheet, so check it's loaded on demand.

## Procedure

1. **Pick and measure the target.** If empty, rank by how often it runs × data volume. For the top pick, capture a **baseline number** the way that path is actually used. Report it.
2. **Find the root cause.** Confirm it's the actual bottleneck, not an assumption.
3. **Fix at the root.** Keep the result identical (diff before/after on the same input).
4. **Re-measure.** Same workload, same method. If the delta is noise at realistic scale, **revert**.
5. **Guard it** where a test fits: assert the structural win (one parse, bounded points), not a flaky wall-clock threshold.
6. **Verify and review.** `pnpm check`, `pnpm test` and `pnpm build`; report counts. For a change to `src/lib/ewr`, run the `ewr-reviewer` agent.
7. **Commit** scoped; push the branch and open a PR, **never push `main`**.

## Report

```
## /perf-hunt — <scope>

**Target + baseline:** <path> — <how measured> → <before number>

**Problem:** <root cause> — bites at n ≈ <scale>

**Fix:** <what> — result identical (verified)

**After:** <same measurement → after number> | **delta:** <e.g. 1200 ms → 40 ms>

**Guard:** <test that locks it — or "structural; covered by <x>">

**Verification:** <pnpm check; tests N/N; build>

**Commits:** <hash + subject>

**Deferred / recommended:** <bigger wins out of scope — or "nothing outstanding">
```

## Tone

Numbers or it didn't happen. Lead with before→after. If the suspected hot path turned out fine at realistic scale, say so and move on.
