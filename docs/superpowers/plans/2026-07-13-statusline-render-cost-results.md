# Measured results — terminal width cache

**Date:** 2026-07-13
**Branch:** `perf/terminal-width-cache`
**Machine:** 6-core Linux, heavily loaded (loadavg ~36), ~67 concurrent Claude sessions

## Baseline (before)

Measured by sampling `/proc` every 50ms for 2 hours and summing CPU per matching process:

| Metric | Value |
| --- | --- |
| Renders | 2,972 (~25/min) |
| CPU consumed | 4,845 CPU-seconds |
| Share of machine | 11.2% sustained (67.3% of one core) |
| Mean per render | 1.63 CPU-seconds (1.30 in `node` + 0.33 in sampled children) |

That 11.2% is an **undercount**: the sampler matched only `node ccstatusline`
processes, not the `sh`/`ps`/`tput`/`stty` children they spawned.

A CPU profile of one render attributed **6.5s of 9.9s to `spawnSync`**.

## A/B benchmark (after)

Identical payload (`scripts/payload.example.json`), same machine, mean of 5 runs.
CPU time is `user + sys` from GNU `time`, which includes waited-for children.

| Metric | Before (installed v2.2.19) | After (this branch) | Change |
| --- | --- | --- | --- |
| `execve` per render | **122** | **1** | −99.2% |
| CPU per render | **4.37 CPU-s** | **1.08 CPU-s** | **−75%** |
| `sys` time per render | 1.94 s | 0.14 s | −93% |

The single remaining `execve` is `node` itself. On a cold cache *and* a warm cache
the count is 1: the native `/proc` + `TIOCGWINSZ` probe spawns nothing at all, so
even a cache miss costs no subprocess on Linux.

## Correctness (not just speed)

The old code spawned 122 processes to arrive at the **wrong** answer. Under a real
PTY:

| Source | Reported width |
| --- | --- |
| `stty -F /dev/pts/7 size` (ground truth) | **209** |
| Old `tput cols` fallback | 80 (its no-TTY default) |
| New native probe | **209** |

## Cross-process cache

Verified end-to-end. After one render:

```json
{"version":1,"entries":{"<session_id>":{"width":209,"createdAt":1783937358448}}}
```

Keyed by `session_id`, TTL'd by `terminalWidthCacheTtlSeconds` (default 5s), atomic
`tmp`+`rename` writes, pruned after an hour, corruption treated as a miss.

## What now dominates

The remaining ~1.08 CPU-s per render is almost entirely Node parsing and evaluating
the 3.16MB bundle. `src/ccstatusline.ts` statically imports `runTUI` from `./tui`, so
React 19 + Ink 6 are compiled on **every** render despite only being needed for
interactive config. That is the deferred follow-up PR (dynamic `import()` +
`bun build --splitting`), and it is now the largest single remaining cost.

## Post-install 2h sampler (measured 2026-07-13 12:07–14:07)

The build was installed over the live statusline (reversibly, via
`~/.claude/jobs-statusline.sh`) and the same 2h `/proc` sampler re-run. Both runs
below sum **all** sampled categories, so they are like-for-like:

| | Before | After |
| --- | --- | --- |
| Renders | 2,972 (24.8/min) | 6,638 (**55.3/min**) |
| `ccstatusline` CPU-s | 3,872.8 | 7,819.7 |
| `wrapper` (children) CPU-s | 972.7 | **2.8** |
| Sampler-visible CPU per render | 1.630 | **1.178** |
| Share of the 6-core machine | 11.22% | **18.11%** |

**The raw machine share went up, and that is not a regression.** Two things changed
at once, and both must be held in view:

1. **The render rate more than doubled** (24.8 → 55.3/min) between the two windows —
   more concurrent Claude sessions, nothing to do with this change.
2. **The sampler undercounts the *before* run far more than the *after* run.** It
   scans `/proc` every 50ms; the stock build's `ps`/`tput` children live ~10ms, so
   most are never sampled at all (23,766 child processes were caught, against the
   ~360,000 that 121 execve/render × 2,972 renders implies). The new build spawns no
   children, so its coverage is essentially complete.

Correcting for coverage using the A/B per-render cost (GNU `time`, which *does*
include waited-for children):

| Scenario | Renders/min | CPU/render | Machine share |
| --- | --- | --- | --- |
| Before, as it actually ran | 24.8 | 4.37 | **~30.1%** (sampler saw 11.2%) |
| After, as it actually runs | 55.3 | 1.18 | **18.1%** (sampler agrees: 18.11%) |
| Counterfactual: stock at today's rate | 55.3 | 4.37 | **~67.1%** |

So the fix avoids roughly **49 points of a 6-core machine** at the current load.

The two instruments **cross-validate on the "after" figure** — the A/B predicted 1.08
CPU-s/render and the live sampler measured 1.178 (the gap is the wrapper `bash`). They
disagree on "before" precisely where the sampler is known to be blind.

**The earlier projection in this document was wrong.** It predicted 2–3% of the
machine by scaling the 11.2% baseline by the A/B ratio. Both of its assumptions
failed: the baseline was itself an undercount, and it held the render rate constant
when the rate in fact doubled. Recorded here rather than deleted, because the failure
mode — extrapolating from a number you have already labelled unreliable — is the
lesson.

## Test suite

- `terminal.test.ts` 15 pass, `terminal-native.test.ts` 7 pass, `terminal-width-cache.test.ts` 10 pass.
- Full suite: 1,650 pass / 17 fail. All 17 failures are pre-existing — verified by
  running the same files at base commit `1af051e` with none of these changes applied,
  where they fail identically (flaky ink TUI render/keystroke tests and `fetchUsageData`
  timeout tests). The failing set rotates between runs.
- `bun run lint` clean.
