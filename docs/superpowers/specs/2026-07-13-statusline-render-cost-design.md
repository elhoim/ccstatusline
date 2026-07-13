# Reducing ccstatusline per-render CPU cost

**Date:** 2026-07-13
**Status:** Approved for implementation
**Scope:** This spec covers PR 1 (terminal-width probing). The lazy-TUI build change is
specified as a follow-up in "Deferred work" and is explicitly out of scope here.

## Problem

ccstatusline is re-executed from scratch on every statusline render. Measured on a 6-core
Linux box running many concurrent Claude Code sessions:

| Measurement | Value |
| --- | --- |
| Window | 2 hours, sampled from `/proc` every 50ms |
| Renders | 2,972 (~25/min) |
| CPU consumed | 4,845 CPU-seconds |
| Share of machine | 11.2% sustained (67.3% of one core) |
| Mean per render | 1.30 CPU-seconds |

That figure is an undercount: it counts only the `node ccstatusline` processes, not the
child processes they spawn.

An `strace -f -e trace=execve` of a single render shows **113 `execve` calls**. A CPU
profile attributes ~6.5s of a 9.9s profiled render to `spawnSync`. Practically all of it
comes from terminal-width detection in `src/utils/terminal.ts`:

- `probeTerminalWidth()` is not memoized, and **the negative result is what costs us**.
  `ccstatusline.ts:170` probes once into `context.terminalWidth`. But `renderer.ts:162`,
  `renderer.ts:975` and `widgets/TerminalWidth.ts:20` all read it as
  `context.terminalWidth ?? getTerminalWidth()`. Claude Code spawns the statusline with no
  TTY, so the probe returns `null` — and `null ?? getTerminalWidth()` **re-probes every
  time**. The nullish-coalescing fallback defeats the single probe that already ran, once
  per configured line (4 lines in the reference config).
- Each probe walks up to 8 process ancestors hunting for a TTY. Per ancestor it runs
  `ps -o ppid= -p N` and `ps -o tty= -p N`; each `execSync` passes `shell: '/bin/sh'`,
  so every probe costs **two** processes (`sh` + `ps`).
- `getWidthForTTY()` runs `stty ... | awk` through a shell: **three** processes per attempt.
- The `tput cols` fallback adds `sh` + `tput`.

Git is *not* a contributor — the existing cross-process git cache
(`~/.cache/ccstatusline/git-cache/`, `gitCacheTtlSeconds`) works, and no git command
appears in the trace.

The current code is also **wrong**, not merely slow. Under a real PTY, the `tput cols`
fallback returns `80` (its no-TTY default) while the terminal is actually `209` columns
wide.

## Goals

1. Eliminate the per-render subprocess storm (113 spawns → 0 on Linux).
2. Share the probe result across processes, so concurrent sessions and back-to-back
   renders do not each re-probe.
3. Return a *correct* width more often than the current code does.
4. Stay upstream-mergeable: no new long-lived processes, no new runtime dependencies,
   no behavior change on platforms we cannot test.

## Non-goal: a shared daemon

The original idea was to have ccstatusline processes share work via a resident daemon.
The measurements argue against it. The genuinely shareable *data* — git status, usage,
JSONL token metrics — is already cross-process cached upstream (`git-cache/`,
`usage.json` + lockfile, `jsonl-cache.ts`). The dominant cost was never duplicated data;
it was redundant probing that should not happen even once. After this spec lands, the
remaining per-render cost approaches bare Node startup (~0.08 CPU-s), which a daemon
could not meaningfully improve — while adding a supervised process, a socket protocol,
staleness bugs, and no upstream path. Revisit only if post-landing measurement
contradicts this.

## Design

### Component 1 — Two-tier terminal-width cache

**L1 (in-process memo).** Cache the probe result in a module-level variable. Within a
single render the terminal cannot resize, so the probe is pure. Both `getTerminalWidth()`
and `canDetectTerminalWidth()` read the memo. Export `resetTerminalWidthCache()` for
tests and for the TUI to re-probe after a resize. This removes the per-line multiplier.

**The memo must cache `null`.** This is the crux, not an edge case: the no-TTY result is
exactly what the current code re-probes 113 times. The memo therefore needs an explicit
"have we probed?" sentinel — a truthiness- or `??`-based memo would faithfully reproduce
the bug it exists to fix. For the same reason the negative result is persisted in L2 too.
Callers keep their `context.terminalWidth ?? getTerminalWidth()` shape (no call-site churn,
smaller diff to review); it is now safe because the fallback hits the memo, not the probe.

**L2 (persisted, TTL'd).** Cache to `~/.cache/ccstatusline/terminal-width.json`, mirroring
the existing git-cache pattern. On miss or expiry, probe and write back.

- **Key: `session_id`** from the incoming `StatusJSON`. Width is per-terminal, not global —
  a single shared value would serve an 80-column session the width of a 209-column one.
  `session_id` is always present and stable for the life of a session, and one session maps
  to one terminal.
- **Writes are atomic:** write to a temp file and `rename()` into place, so concurrent
  sessions cannot observe a torn file. A corrupt or unparseable cache file is treated as a
  miss, never a crash.
- **Pruning:** drop entries older than 1 hour on write, so the file does not grow without
  bound across many sessions.
- **TTL:** new `terminalWidthCacheTtlSeconds` setting alongside `gitCacheTtlSeconds`.
  Default **5**, clamped to 0–300. `0` disables caching (always probe).

The only cost of caching is resize latency: after a mid-session resize the statusline
renders at the stale width for up to one TTL, then self-corrects.

### Component 2 — Zero-spawn probe, existing path kept as fallback

Add a native probe attempted *before* any subprocess:

1. **Ancestry walk with no `ps`:** read `/proc/<pid>/stat`, field 4, for the ppid. The
   `comm` field can contain spaces and parentheses, so parse fields *after the last* `)`.
2. **Find the terminal with no `ps`:** `readlink` each ancestor's `/proc/<pid>/fd/{0,1,2}`
   and take the first target matching `/dev/pts/*` or `/dev/tty*`. This is what actually
   locates the PTY that Claude Code denied us.
3. **Get columns with no `stty`/`awk`:** open that device `O_RDONLY|O_NOCTTY`, confirm
   `tty.isatty(fd)`, and read `.columns` from a `tty.WriteStream` (Node's `TIOCGWINSZ`).
   Always close the fd.

If `/proc` is unavailable (macOS, BSD) the code falls through to the **existing** ancestry
walk and `tput` fallback, unchanged in behavior. While there, replace `execSync` +
`shell: '/bin/sh'` with `execFileSync` in those fallbacks, halving their process count by
dropping the `sh` wrapper.

The `CCSTATUSLINE_WIDTH` env override keeps short-circuiting everything, before both cache
tiers and the probe.

Verified working: the native probe returns `{"width":209,"device":"/dev/pts/7"}` under a
real PTY with a single `execve` (node itself), where `tput cols` returns `80`.

### Data flow

```
getTerminalWidth()
  -> CCSTATUSLINE_WIDTH override?            -> return
  -> L1 module memo?                         -> return
  -> L2 disk cache, fresh within TTL?        -> populate L1, return
  -> probe:
       Linux:    /proc ancestry -> fd readlink -> TIOCGWINSZ   (0 spawns)
       fallback: ps ancestry (execFileSync) -> stty -> tput
  -> write L2 (atomic, pruned), populate L1, return
```

## Testing

`src/utils/__tests__/terminal.test.ts` already exists: it mocks `child_process` via
`vi.mock` and pins `process.platform` to `darwin` for the POSIX tests. Those tests must
keep passing untouched — which is why the native probe is gated on Linux *and* the presence
of `/proc`, leaving the `ps`/`stty`/`tput` path as the thing `darwin` still exercises.

Extend that file (injecting filesystem dependencies for the new paths, following the
pattern already used by `git-review-cache.ts`):

- **Memoization:** repeated `getTerminalWidth()` + `canDetectTerminalWidth()` calls invoke
  the underlying probe exactly once.
- **Null memoization (regression test for the actual bug):** when the probe finds no TTY,
  N calls to `getTerminalWidth()` still probe only *once* — asserting on the mocked spawn
  call count. This is the test that would have caught the 113-spawn behavior.
- **`/proc` stat parsing:** a synthetic stat line whose `comm` contains spaces and a `)`
  still yields the correct ppid.
- **TTY discovery:** an ancestor whose fd 0/1/2 point at `/dev/pts/N` is found; one with no
  tty is skipped and the walk continues.
- **L2 cache:** a fresh entry is reused without probing; an expired entry re-probes; a
  corrupt file is treated as a miss, not a crash; `terminalWidthCacheTtlSeconds: 0`
  always probes; entries are keyed by `session_id` so two sessions do not share a width.
- **Override:** `CCSTATUSLINE_WIDTH` short-circuits both cache and probe.
- **No TTY anywhere:** returns `null` gracefully (the documented Windows / no-ancestor case).

## Verification (empirical, repeating this session's measurements)

1. `strace -f -e trace=execve` on one render: expect **113 → ~0** child spawns.
2. Re-run the 2h `/proc` sampler: expect mean per-render CPU **1.30 CPU-s → ~0.1–0.3**,
   i.e. machine share **11.2% → ~1–2%**, with the uncounted `sh`/`ps`/`tput` children gone.
3. Confirm correctness against a real PTY: reported width must match `stty size`, not the
   `80`-column fallback.

## Deferred work (follow-up PR)

**Lazy-load the TUI.** `src/ccstatusline.ts` line 4 statically imports `runTUI` from
`./tui`, so React 19 + Ink 6 are parsed and evaluated on *every* render despite only being
needed for interactive config — roughly 0.5–1 CPU-s per render, and the reason the bundle
is 3.16MB. The fix is a dynamic `await import('./tui')` inside the interactive branch,
which requires the build to emit chunks (`bun build --splitting --outdir dist`) instead of
a single `--outfile`. `package.json` already ships `files: ["dist/"]` and `bin` still points
at `dist/ccstatusline.js`, so packaging should hold — but this changes build output shape
and carries packaging risk, so it ships separately from the pure-win width fixes.
