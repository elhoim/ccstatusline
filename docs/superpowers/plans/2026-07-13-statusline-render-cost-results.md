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
| Mean per render | 1.30 CPU-seconds |

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

## Not yet measured

The 2h `/proc` sampler has **not** been re-run against this build. Doing so requires
installing it over the live `/usr/local/bin/ccstatusline`, which would affect all
running sessions; deferred pending a decision to install. Extrapolating the A/B ratio
(1.08 / 4.37) from the 11.2% baseline suggests roughly **2–3% of the machine**, but
that is a projection, not a measurement, and it is recorded here as such.

## Test suite

- `terminal.test.ts` 15 pass, `terminal-native.test.ts` 7 pass, `terminal-width-cache.test.ts` 10 pass.
- Full suite: 1,650 pass / 17 fail. All 17 failures are pre-existing — verified by
  running the same files at base commit `1af051e` with none of these changes applied,
  where they fail identically (flaky ink TUI render/keystroke tests and `fetchUsageData`
  timeout tests). The failing set rotates between runs.
- `bun run lint` clean.
