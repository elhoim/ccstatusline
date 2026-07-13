# Terminal Width Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut ccstatusline's per-render CPU cost by eliminating the 113 child processes it spawns to probe terminal width, and by sharing the probe result across renders and sessions.

**Architecture:** Three layers, added in order of payoff. (1) Memoize the width probe in-process — *including the `null` result*, which is the actual bug: Claude Code gives the statusline no TTY, the probe returns `null`, and callers written as `context.terminalWidth ?? getTerminalWidth()` therefore re-probe on every line. (2) Add a zero-spawn native probe on Linux (`/proc` ancestry + `TIOCGWINSZ`), keeping the existing `ps`/`stty`/`tput` walk as the non-Linux fallback. (3) Persist the result to a TTL'd disk cache keyed by `session_id`, mirroring the existing git-cache.

**Tech Stack:** TypeScript, Bun (build + test runner), Vitest, Zod (settings schema), Node `fs`/`tty` built-ins. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-13-statusline-render-cost-design.md`

## Global Constraints

- **No new runtime dependencies.** Node built-ins only (`fs`, `tty`, `path`, `os`, `crypto`).
- **No behavior change off Linux.** The native probe is gated on `process.platform === 'linux'` AND `/proc` being readable. `src/utils/__tests__/terminal.test.ts` pins `process.platform` to `'darwin'` for its POSIX tests; **those existing tests must keep passing unmodified.**
- **Cache failures are never fatal.** A corrupt, unreadable, or unwritable cache file is a miss, never a throw. The statusline must render regardless.
- **Never disable a lint rule via a comment** (repo rule, CLAUDE.md).
- **Lint/typecheck command is `bun run lint`.** Never invoke `eslint`, `tsc`, `npx`, or `tsx` directly (repo rule, CLAUDE.md).
- **Test command is `bun test`** (Vitest under Bun).
- **Settings schema** lives in `src/types/Settings.ts` and is Zod-validated. New key: `terminalWidthCacheTtlSeconds: z.number().min(0).max(300).default(5)`.
- **TTL semantics divergence (deliberate, must be commented in code and called out in the PR):** the sibling `gitCacheTtlSeconds` treats `0` as *never expire* (`src/utils/git.ts`: `return ttlMs === 0 || ...`). For `terminalWidthCacheTtlSeconds`, `0` means **always probe / caching disabled**, per the approved spec. These differ; a reviewer will notice. Document it inline.
- **Commit after every task.** Conventional commit prefixes (`perf:`, `feat:`, `test:`, `refactor:`).

---

### Task 1: Memoize the probe, including the `null` result

This is the whole bug. Do it first, alone, so its effect is measurable in isolation.

**Files:**
- Modify: `src/utils/terminal.ts` (lines 171–179, the `getTerminalWidth` / `canDetectTerminalWidth` exports)
- Test: `src/utils/__tests__/terminal.test.ts` (append to existing `describe('terminal utils')`)

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `getTerminalWidth(): number | null` — unchanged signature, now memoized.
  - `canDetectTerminalWidth(): boolean` — unchanged signature, now reads the memo.
  - `resetTerminalWidthCache(): void` — **new export**, clears the memo. Required by tests (module state persists across `it()` blocks) and used by the TUI to re-probe after a resize.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe('terminal utils', ...)` block in `src/utils/__tests__/terminal.test.ts`. Add `resetTerminalWidthCache` to the existing import from `'../terminal'`, and add `beforeEach(() => { resetTerminalWidthCache(); });` inside the describe (alongside the existing `beforeEach`) so the memo never leaks between tests.

```typescript
    it('probes only once across repeated calls when a width is found', () => {
        pinPosixPlatform();
        mockExecSync.mockImplementation((command: string) => {
            if (command === `ps -o ppid= -p ${process.pid}`) {
                return '1234\n';
            }

            if (command === 'ps -o tty= -p 1234') {
                return 'ttys001\n';
            }

            if (command === `stty -F /dev/ttys001 size 2>/dev/null | awk '{print $2}'`) {
                return '120\n';
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        expect(getTerminalWidth()).toBe(120);
        expect(getTerminalWidth()).toBe(120);
        expect(canDetectTerminalWidth()).toBe(true);

        const ppidProbes = mockExecSync.mock.calls.filter(
            call => typeof call[0] === 'string' && (call[0] as string).startsWith('ps -o ppid=')
        );
        expect(ppidProbes).toHaveLength(1);
    });

    // Regression test for the 113-spawn bug: Claude Code spawns the statusline with
    // no TTY, so the probe returns null. Callers use `context.terminalWidth ??
    // getTerminalWidth()`, so a memo that does not cache null re-probes forever.
    it('probes only once when NO tty is found (null is memoized)', () => {
        pinPosixPlatform();
        mockExecSync.mockImplementation(() => {
            throw new Error('no tty anywhere');
        });

        expect(getTerminalWidth()).toBeNull();
        expect(getTerminalWidth()).toBeNull();
        expect(getTerminalWidth()).toBeNull();
        expect(canDetectTerminalWidth()).toBe(false);

        const ppidProbes = mockExecSync.mock.calls.filter(
            call => typeof call[0] === 'string' && (call[0] as string).startsWith('ps -o ppid=')
        );
        expect(ppidProbes).toHaveLength(1);
    });

    it('resetTerminalWidthCache forces a re-probe', () => {
        pinPosixPlatform();
        process.env.CCSTATUSLINE_WIDTH = '150';
        expect(getTerminalWidth()).toBe(150);

        process.env.CCSTATUSLINE_WIDTH = '175';
        expect(getTerminalWidth()).toBe(150); // memoized, not re-read

        resetTerminalWidthCache();
        expect(getTerminalWidth()).toBe(175);
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/utils/__tests__/terminal.test.ts`
Expected: FAIL. The two `probes only once` tests fail on the spawn-count assertion (`expected length 4, got 1`-style — the probe reran per call). The `resetTerminalWidthCache` test fails to even import: `resetTerminalWidthCache is not exported`.

- [ ] **Step 3: Write minimal implementation**

Replace the two exported functions at the bottom of `src/utils/terminal.ts` (currently lines 171–179):

```typescript
// Memoized probe result. `hasProbed` is a separate flag rather than a
// `null`-check on `cachedWidth`, because `null` (no TTY found) is a real,
// cacheable answer -- and the common one: Claude Code spawns the statusline
// with no controlling terminal. Callers do `context.terminalWidth ??
// getTerminalWidth()`, so treating `null` as "not yet probed" would re-run the
// full ancestor walk on every line of every render.
let hasProbed = false;
let cachedWidth: number | null = null;

/** Clear the memoized width. For tests, and for the TUI to re-probe after a resize. */
export function resetTerminalWidthCache(): void {
    hasProbed = false;
    cachedWidth = null;
}

// Get terminal width
export function getTerminalWidth(): number | null {
    if (!hasProbed) {
        cachedWidth = probeTerminalWidth();
        hasProbed = true;
    }

    return cachedWidth;
}

// Check if terminal width detection is available
export function canDetectTerminalWidth(): boolean {
    return getTerminalWidth() !== null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/utils/__tests__/terminal.test.ts`
Expected: PASS, all tests including the pre-existing ones.

Run: `bun test`
Expected: PASS (full suite; nothing else depends on repeated probing).

Run: `bun run lint`
Expected: clean.

- [ ] **Step 5: Verify the real-world effect**

```bash
bun run build
cat scripts/payload.example.json | strace -f -e trace=execve -o /tmp/after1.log node dist/ccstatusline.js >/dev/null 2>&1
grep -c execve /tmp/after1.log
```
Expected: substantially below the 113 baseline (the per-line multiplier is gone; one walk remains). Record the number in the commit message.

- [ ] **Step 6: Commit**

```bash
git add src/utils/terminal.ts src/utils/__tests__/terminal.test.ts
git commit -m "perf: memoize terminal width probe, including the null result

Claude Code spawns the statusline without a TTY, so probeTerminalWidth()
returns null. Callers read it as `context.terminalWidth ?? getTerminalWidth()`,
so the null re-triggered the full ps/stty ancestor walk once per configured
line. Cache the probe behind an explicit hasProbed flag so the negative
result is memoized too."
```

---

### Task 2: Zero-spawn native probe on Linux

**Files:**
- Create: `src/utils/terminal-native.ts`
- Modify: `src/utils/terminal.ts` (call the native probe first inside `probeTerminalWidth`)
- Test: `src/utils/__tests__/terminal-native.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (independent module).
- Produces:
  - `probeWidthNative(deps?: NativeProbeDeps): number | null` — returns the width, or `null` if unsupported/not found. Never throws.
  - `interface NativeProbeDeps { readFileSync: (p: string) => string; readlinkSync: (p: string) => string; openSync: (p: string, flags: number) => number; closeSync: (fd: number) => void; isatty: (fd: number) => boolean; getColumns: (fd: number) => number | null; platform: string; }` — all fields required; injected only by tests. Production calls `probeWidthNative()` with no argument.
  - `parsePpidFromStat(stat: string): number | null` — exported for direct unit testing.

Why these three mechanisms: `/proc/<pid>/stat` field 4 gives the ppid without `ps`; readlinking `/proc/<pid>/fd/{0,1,2}` finds the PTY device without `ps -o tty=`; opening that device and reading `.columns` off a `tty.WriteStream` is `TIOCGWINSZ` without `stty`/`awk`. Verified against a real PTY: returns 209 columns in 0 spawns, where `tput cols` returns the wrong answer (80).

- [ ] **Step 1: Write the failing test**

Create `src/utils/__tests__/terminal-native.test.ts`:

```typescript
import {
    describe,
    expect,
    it
} from 'vitest';

import type { NativeProbeDeps } from '../terminal-native';
import {
    parsePpidFromStat,
    probeWidthNative
} from '../terminal-native';

// A /proc/<pid>/stat line whose comm field contains spaces AND a close-paren.
// Naive `split(' ')[3]` gets this wrong; fields must be read after the LAST ')'.
const TRICKY_STAT = '4242 (my ) weird proc) S 1234 4242 4242 0 -1 4194304 100 0 0 0 5 3 0 0 20 0 1 0 999 0 0';

function makeDeps(overrides: Partial<NativeProbeDeps> = {}): NativeProbeDeps {
    return {
        platform: 'linux',
        readFileSync: () => { throw new Error('unexpected readFileSync'); },
        readlinkSync: () => { throw new Error('unexpected readlinkSync'); },
        openSync: () => 7,
        closeSync: () => undefined,
        isatty: () => true,
        getColumns: () => 209,
        ...overrides
    };
}

describe('parsePpidFromStat', () => {
    it('parses the ppid when comm contains spaces and parens', () => {
        expect(parsePpidFromStat(TRICKY_STAT)).toBe(1234);
    });

    it('returns null on garbage', () => {
        expect(parsePpidFromStat('not a stat line')).toBeNull();
    });
});

describe('probeWidthNative', () => {
    it('returns null on non-linux platforms', () => {
        expect(probeWidthNative(makeDeps({ platform: 'darwin' }))).toBeNull();
    });

    it('walks ancestors and returns the width of the first tty found', () => {
        const deps = makeDeps({
            // self -> 4242 -> 1234. Only 1234 owns a pty.
            readFileSync: (p: string) => {
                if (p === `/proc/${process.pid}/stat`) {
                    return '1 (node) S 4242 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 1 0 0';
                }

                if (p === '/proc/4242/stat') {
                    return TRICKY_STAT;
                }

                throw new Error(`no such stat: ${p}`);
            },
            readlinkSync: (p: string) => {
                if (p === '/proc/1234/fd/0') {
                    return '/dev/pts/7';
                }

                throw new Error(`not a tty fd: ${p}`);
            },
            getColumns: () => 209
        });

        expect(probeWidthNative(deps)).toBe(209);
    });

    it('returns null when no ancestor owns a tty', () => {
        const deps = makeDeps({
            readFileSync: () => '1 (node) S 0 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 1 0 0',
            readlinkSync: () => { throw new Error('ENOENT'); }
        });

        expect(probeWidthNative(deps)).toBeNull();
    });

    it('returns null (and does not throw) when the device is not a tty', () => {
        const deps = makeDeps({
            readFileSync: (p: string) => (p === `/proc/${process.pid}/stat`
                ? '1 (node) S 1234 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 1 0 0'
                : (() => { throw new Error('stop'); })()),
            readlinkSync: () => '/dev/pts/7',
            isatty: () => false
        });

        expect(probeWidthNative(deps)).toBeNull();
    });

    it('closes the fd even when getColumns throws', () => {
        const closed: number[] = [];
        const deps = makeDeps({
            readFileSync: (p: string) => (p === `/proc/${process.pid}/stat`
                ? '1 (node) S 1234 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 1 0 0'
                : (() => { throw new Error('stop'); })()),
            readlinkSync: () => '/dev/pts/7',
            closeSync: (fd: number) => { closed.push(fd); },
            getColumns: () => { throw new Error('ioctl failed'); }
        });

        expect(probeWidthNative(deps)).toBeNull();
        expect(closed).toEqual([7]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/utils/__tests__/terminal-native.test.ts`
Expected: FAIL — `Cannot find module '../terminal-native'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/utils/terminal-native.ts`:

```typescript
import * as fs from 'fs';
import * as tty from 'tty';

const MAX_ANCESTOR_DEPTH = 8;
const STDIO_FDS = [0, 1, 2] as const;

export interface NativeProbeDeps {
    readFileSync: (path: string) => string;
    readlinkSync: (path: string) => string;
    openSync: (path: string, flags: number) => number;
    closeSync: (fd: number) => void;
    isatty: (fd: number) => boolean;
    getColumns: (fd: number) => number | null;
    platform: string;
}

const defaultDeps: NativeProbeDeps = {
    readFileSync: (path: string) => fs.readFileSync(path, 'utf-8'),
    readlinkSync: (path: string) => fs.readlinkSync(path, 'utf-8'),
    openSync: (path: string, flags: number) => fs.openSync(path, flags),
    closeSync: (fd: number) => { fs.closeSync(fd); },
    isatty: (fd: number) => tty.isatty(fd),
    getColumns: (fd: number) => {
        // tty.WriteStream reads the window size via TIOCGWINSZ. No subprocess.
        const stream = new tty.WriteStream(fd);
        const columns = stream.columns;
        return typeof columns === 'number' && columns > 0 ? columns : null;
    },
    platform: process.platform
};

/**
 * Parse the ppid (field 4) out of a /proc/<pid>/stat line.
 * The comm field (2) is wrapped in parens and may itself contain spaces and
 * parens, so fields must be read after the LAST ')'.
 */
export function parsePpidFromStat(stat: string): number | null {
    const commEnd = stat.lastIndexOf(')');
    if (commEnd === -1) {
        return null;
    }

    // After "(comm)" the remaining fields are: state, ppid, ...
    const fields = stat.slice(commEnd + 1).trim().split(/\s+/);
    const ppid = parseInt(fields[1] ?? '', 10);
    if (isNaN(ppid) || ppid <= 0) {
        return null;
    }

    return ppid;
}

function findTTYDevice(pid: number, deps: NativeProbeDeps): string | null {
    for (const fd of STDIO_FDS) {
        try {
            const target = deps.readlinkSync(`/proc/${pid}/fd/${fd}`);
            if (target.startsWith('/dev/pts/') || target.startsWith('/dev/tty')) {
                return target;
            }
        } catch {
            // fd missing or not readable; try the next one
        }
    }

    return null;
}

function widthOfDevice(device: string, deps: NativeProbeDeps): number | null {
    let fd: number | null = null;
    try {
        // O_NOCTTY: never adopt this device as our controlling terminal.
        fd = deps.openSync(device, fs.constants.O_RDONLY | fs.constants.O_NOCTTY);
        if (!deps.isatty(fd)) {
            return null;
        }

        return deps.getColumns(fd);
    } catch {
        return null;
    } finally {
        if (fd !== null) {
            try {
                deps.closeSync(fd);
            } catch {
                // best-effort
            }
        }
    }
}

/**
 * Probe terminal width with zero subprocesses, using /proc and TIOCGWINSZ.
 * Linux only; returns null anywhere else so the caller falls back to the
 * portable ps/stty/tput path.
 */
export function probeWidthNative(deps: NativeProbeDeps = defaultDeps): number | null {
    if (deps.platform !== 'linux') {
        return null;
    }

    let pid = process.pid;
    for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
        let stat: string;
        try {
            stat = deps.readFileSync(`/proc/${pid}/stat`);
        } catch {
            return null;
        }

        const parentPid = parsePpidFromStat(stat);
        if (parentPid === null || parentPid <= 1) {
            return null;
        }

        pid = parentPid;

        const device = findTTYDevice(pid, deps);
        if (device === null) {
            continue;
        }

        const width = widthOfDevice(device, deps);
        if (width !== null) {
            return width;
        }
    }

    return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/utils/__tests__/terminal-native.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Wire it into the probe chain**

In `src/utils/terminal.ts`, add the import and call the native probe *after* the `CCSTATUSLINE_WIDTH` override and the win32 guard, but *before* the ancestor walk. Insert immediately after the `if (process.platform === 'win32') { return null; }` block (currently line 54):

```typescript
    // Zero-subprocess path (Linux): /proc ancestry + TIOCGWINSZ. Returns null on
    // other platforms and falls through to the portable ps/stty/tput walk below.
    const nativeWidth = probeWidthNative();
    if (nativeWidth !== null) {
        return nativeWidth;
    }
```

And at the top of the file:

```typescript
import { probeWidthNative } from './terminal-native';
```

- [ ] **Step 6: Run the full suite**

Run: `bun test`
Expected: PASS. Critically, the pre-existing `terminal.test.ts` tests still pass: they pin `process.platform` to `'darwin'`, so `probeWidthNative` short-circuits to `null` and the `ps`/`stty` path they assert on is unchanged.

Run: `bun run lint`
Expected: clean.

- [ ] **Step 7: Verify zero spawns on a real terminal**

```bash
bun run build
script -qc "cat scripts/payload.example.json | strace -f -e trace=execve node dist/ccstatusline.js >/dev/null 2>/tmp/tr.log; grep -c execve /tmp/tr.log" /dev/null
script -qc "stty size" /dev/null   # ground truth: rows cols
```
Expected: execve count is `1` (node itself). The width the statusline renders at must match the `cols` from `stty size` — NOT 80.

- [ ] **Step 8: Commit**

```bash
git add src/utils/terminal-native.ts src/utils/__tests__/terminal-native.test.ts src/utils/terminal.ts
git commit -m "perf: add zero-subprocess terminal width probe on Linux

Read ancestry from /proc/<pid>/stat, locate the pty by readlinking
/proc/<pid>/fd/{0,1,2}, and get columns via TIOCGWINSZ (tty.WriteStream)
instead of spawning sh+ps / sh+stty+awk / sh+tput. The portable walk
remains as the fallback for macOS/BSD.

Also more correct: under a real pty this reports the true width where the
tput fallback reported its no-tty default of 80."
```

---

### Task 3: Drop the `/bin/sh` wrapper from the fallback path

Halves the process count on the platforms that still use the portable walk (macOS/BSD, and Linux when `/proc` is unavailable). `execSync` with `shell: '/bin/sh'` spawns a shell *and* the command; `execFileSync` spawns only the command.

**Files:**
- Modify: `src/utils/terminal.ts` (`getParentProcessId` ~line 104, `getTTYForProcess` ~line 119, `getWidthForTTY` ~line 138, `tput` fallback ~line 80)
- Test: `src/utils/__tests__/terminal.test.ts` (the existing tests mock `execSync` by *command string*; they must be updated to mock `execFileSync` by file+args)

**Interfaces:**
- Consumes: `probeTerminalWidth` internals from Tasks 1–2. No exported signature changes.
- Produces: no new exports. Behavior identical; only the spawn mechanism changes.

**Note on `getWidthForTTY`:** it currently pipes `stty ... | awk '{print $2}'`, which *requires* a shell. Drop the pipe: call `execFileSync('stty', ['-F', device, 'size'])` and parse the second whitespace-separated field in JS. Same result, one process instead of three.

- [ ] **Step 1: Update the existing tests to the new mock surface**

In `src/utils/__tests__/terminal.test.ts`, the existing tests assert on `execSync` command strings. Rewrite those assertions against `execFileSync`. Add alongside the existing `mockExecSync`:

```typescript
    const mockExecFileSync = execFileSync as unknown as {
        mock: { calls: unknown[][] };
        mockImplementation: (impl: (file: string, args: string[]) => string) => void;
    };
```

and import `execFileSync` from `'child_process'` at the top (it is already listed in the existing `vi.mock` factory). Then convert each POSIX test, e.g. the "immediate parent tty" test becomes:

```typescript
    it('returns width from the immediate parent tty when available', () => {
        pinPosixPlatform();
        mockExecFileSync.mockImplementation((file: string, args: string[]) => {
            if (file === 'ps' && args.join(' ') === `-o ppid= -p ${process.pid}`) {
                return '1234\n';
            }

            if (file === 'ps' && args.join(' ') === '-o tty= -p 1234') {
                return 'ttys001\n';
            }

            if (file === 'stty' && args.join(' ') === '-F /dev/ttys001 size') {
                return '24 120\n';
            }

            throw new Error(`Unexpected command: ${file} ${args.join(' ')}`);
        });

        expect(getTerminalWidth()).toBe(120);
    });
```

Apply the same conversion to every other POSIX test in the file (parent-walk, stty `-f` BSD fallback, `tput` fallback, no-tty). The `tput` fallback becomes `execFileSync('tput', ['cols'])`. Keep the win32 and `CCSTATUSLINE_WIDTH` tests as they are.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/utils/__tests__/terminal.test.ts`
Expected: FAIL — the implementation still calls `execSync`, so the `execFileSync` mock is never hit and the probes return `null`.

- [ ] **Step 3: Write the implementation**

In `src/utils/terminal.ts`, change the import on line 1 to `import { execFileSync } from 'child_process';` and replace the four call sites:

```typescript
function getParentProcessId(pid: number): number | null {
    try {
        const parentPidOutput = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore'],
            windowsHide: true
        }).trim();

        return parsePositiveInteger(parentPidOutput);
    } catch {
        return null;
    }
}

function getTTYForProcess(pid: number): string | null {
    try {
        const tty = execFileSync('ps', ['-o', 'tty=', '-p', String(pid)], {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore'],
            windowsHide: true
        }).replace(/\s+/g, '');

        if (!tty || tty === '??' || tty === '?') {
            return null;
        }

        return tty;
    } catch {
        return null;
    }
}

function getWidthForTTY(tty: string): number | null {
    // `stty -F` / `-f` ask stty to open the device itself, which succeeds even
    // when we have no controlling terminal (the Claude Code >= 2.1.139 case).
    // Parse "rows cols" in JS rather than piping through awk: no shell, one process.
    const devicePath = `/dev/${tty}`;
    const attempts: string[][] = [
        ['-F', devicePath, 'size'],   // GNU coreutils (Linux)
        ['-f', devicePath, 'size']    // BSD stty (macOS, *BSD)
    ];

    for (const args of attempts) {
        try {
            const output = execFileSync('stty', args, {
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'ignore'],
                windowsHide: true
            }).trim();

            const parsed = parsePositiveInteger(output.split(/\s+/)[1] ?? '');
            if (parsed !== null) {
                return parsed;
            }
        } catch {
            // try next strategy
        }
    }

    return null;
}
```

And the `tput` fallback inside `probeTerminalWidth` (currently lines 80–90):

```typescript
    try {
        const width = execFileSync('tput', ['cols'], {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore'],
            windowsHide: true
        }).trim();

        return parsePositiveInteger(width);
    } catch {
        // tput also failed
    }
```

Note the legacy `stty size < /dev/tty` redirect form is dropped: it needs a shell, and the `-F`/`-f` forms already cover Linux and BSD. Record this in the commit message.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test`
Expected: PASS (full suite).

Run: `bun run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/utils/terminal.ts src/utils/__tests__/terminal.test.ts
git commit -m "perf: use execFileSync instead of a shell in the width fallback

execSync with shell:'/bin/sh' spawned a shell in addition to the command,
doubling every probe; the stty|awk pipe cost three processes. Call the
binaries directly and parse 'rows cols' in JS. Drops the legacy
'stty size < /dev/tty' redirect form, which required a shell and is
redundant with the -F/-f forms."
```

---

### Task 4: Persist the width across processes (TTL'd disk cache)

**Files:**
- Create: `src/utils/terminal-width-cache.ts`
- Modify: `src/types/Settings.ts` (add the TTL key, ~line 71 next to `gitCacheTtlSeconds`)
- Modify: `src/types/RenderContext.ts` (add `terminalWidthCacheTtlSeconds?: number`, ~line 46)
- Modify: `src/utils/terminal.ts` (accept options; consult the disk cache around the probe)
- Modify: `src/ccstatusline.ts` (line ~170: pass `session_id` and the TTL)
- Test: `src/utils/__tests__/terminal-width-cache.test.ts`

**Interfaces:**
- Consumes: `resetTerminalWidthCache()`, `getTerminalWidth()` from Task 1; `probeWidthNative()` from Task 2.
- Produces:
  - `interface WidthCacheDeps { readFileSync: (p: string) => string; writeFileSync: (p: string, data: string) => void; renameSync: (from: string, to: string) => void; mkdirSync: (p: string) => void; now: () => number; cachePath: string; }`
  - `readCachedWidth(sessionId: string, ttlSeconds: number, deps?: WidthCacheDeps): { width: number | null } | null` — returns `null` on miss/expiry/corruption; returns a **wrapper object** on hit, so that a cached `null` (no TTY) is distinguishable from a miss. This distinction is the entire point.
  - `writeCachedWidth(sessionId: string, width: number | null, deps?: WidthCacheDeps): void` — best-effort; never throws.
  - `getTerminalWidth(options?: { sessionId?: string; ttlSeconds?: number }): number | null` — **signature widened** in `terminal.ts`. Existing zero-arg callers (`renderer.ts:162`, `renderer.ts:975`, `widgets/TerminalWidth.ts:20`) keep working unchanged: they hit the L1 memo that the entry point already populated.

Cache file: `~/.cache/ccstatusline/terminal-width.json`, one JSON object holding all sessions:
```json
{ "version": 1, "entries": { "<session_id>": { "width": 209, "createdAt": 1783872234000 } } }
```
Keyed by `session_id` because width is per-terminal: a single global value would serve a 209-column session the width of an 80-column one. Entries older than 1 hour are pruned on write so the file cannot grow without bound across many sessions.

- [ ] **Step 1: Write the failing test**

Create `src/utils/__tests__/terminal-width-cache.test.ts`:

```typescript
import {
    beforeEach,
    describe,
    expect,
    it
} from 'vitest';

import type { WidthCacheDeps } from '../terminal-width-cache';
import {
    readCachedWidth,
    writeCachedWidth
} from '../terminal-width-cache';

const CACHE_PATH = '/tmp/test-terminal-width.json';

function makeDeps(initial: string | null, now = 1_000_000): WidthCacheDeps & { files: Map<string, string> } {
    const files = new Map<string, string>();
    if (initial !== null) {
        files.set(CACHE_PATH, initial);
    }

    return {
        files,
        cachePath: CACHE_PATH,
        now: () => now,
        mkdirSync: () => undefined,
        readFileSync: (p: string) => {
            const content = files.get(p);
            if (content === undefined) {
                throw new Error('ENOENT');
            }

            return content;
        },
        writeFileSync: (p: string, data: string) => { files.set(p, data); },
        renameSync: (from: string, to: string) => {
            const data = files.get(from);
            if (data === undefined) {
                throw new Error('ENOENT');
            }

            files.set(to, data);
            files.delete(from);
        }
    };
}

describe('terminal width cache', () => {
    let deps: ReturnType<typeof makeDeps>;

    beforeEach(() => {
        deps = makeDeps(null);
    });

    it('returns null on a cache miss', () => {
        expect(readCachedWidth('session-a', 5, deps)).toBeNull();
    });

    it('round-trips a width within the TTL', () => {
        writeCachedWidth('session-a', 209, deps);
        expect(readCachedWidth('session-a', 5, deps)).toEqual({ width: 209 });
    });

    // The whole point: a cached "no tty" must be a HIT, not a miss, or the
    // expensive no-tty case re-probes forever.
    it('round-trips a cached null width as a hit', () => {
        writeCachedWidth('session-a', null, deps);
        expect(readCachedWidth('session-a', 5, deps)).toEqual({ width: null });
    });

    it('keys entries by session so sessions do not share a width', () => {
        writeCachedWidth('session-a', 209, deps);
        writeCachedWidth('session-b', 80, deps);
        expect(readCachedWidth('session-a', 5, deps)).toEqual({ width: 209 });
        expect(readCachedWidth('session-b', 5, deps)).toEqual({ width: 80 });
    });

    it('treats an entry older than the TTL as a miss', () => {
        writeCachedWidth('session-a', 209, deps);
        const later = makeDeps(deps.files.get(CACHE_PATH) ?? null, 1_000_000 + 6_000);
        expect(readCachedWidth('session-a', 5, later)).toBeNull();
    });

    it('treats ttlSeconds of 0 as caching disabled (always a miss)', () => {
        writeCachedWidth('session-a', 209, deps);
        expect(readCachedWidth('session-a', 0, deps)).toBeNull();
    });

    it('treats a corrupt cache file as a miss and does not throw', () => {
        const corrupt = makeDeps('{ this is not json');
        expect(() => readCachedWidth('session-a', 5, corrupt)).not.toThrow();
        expect(readCachedWidth('session-a', 5, corrupt)).toBeNull();
    });

    it('never throws when the cache is unwritable', () => {
        const unwritable = makeDeps(null);
        unwritable.writeFileSync = () => { throw new Error('EACCES'); };
        expect(() => writeCachedWidth('session-a', 209, unwritable)).not.toThrow();
    });

    it('prunes entries older than an hour on write', () => {
        writeCachedWidth('stale-session', 100, deps);
        const muchLater = makeDeps(deps.files.get(CACHE_PATH) ?? null, 1_000_000 + 3_600_001);
        writeCachedWidth('fresh-session', 209, muchLater);

        const written = JSON.parse(muchLater.files.get(CACHE_PATH) ?? '{}') as { entries: Record<string, unknown> };
        expect(Object.keys(written.entries)).toEqual(['fresh-session']);
    });

    it('writes atomically via a temp file and rename', () => {
        const renames: string[] = [];
        const tracking = makeDeps(null);
        tracking.renameSync = (from: string, to: string) => { renames.push(`${from}->${to}`); };
        writeCachedWidth('session-a', 209, tracking);
        expect(renames).toHaveLength(1);
        expect(renames[0]).toContain(`->${CACHE_PATH}`);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/utils/__tests__/terminal-width-cache.test.ts`
Expected: FAIL — `Cannot find module '../terminal-width-cache'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/utils/terminal-width-cache.ts`:

```typescript
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CACHE_SCHEMA_VERSION = 1 as const;
const PRUNE_AFTER_MS = 60 * 60 * 1000;

interface WidthCacheEntry {
    width: number | null;
    createdAt: number;
}

interface PersistentWidthCache {
    version: typeof CACHE_SCHEMA_VERSION;
    entries: Record<string, WidthCacheEntry>;
}

export interface WidthCacheDeps {
    readFileSync: (path: string) => string;
    writeFileSync: (path: string, data: string) => void;
    renameSync: (from: string, to: string) => void;
    mkdirSync: (path: string) => void;
    now: () => number;
    cachePath: string;
}

function defaultCachePath(): string {
    return path.join(os.homedir(), '.cache', 'ccstatusline', 'terminal-width.json');
}

const defaultDeps: WidthCacheDeps = {
    readFileSync: (p: string) => fs.readFileSync(p, 'utf-8'),
    writeFileSync: (p: string, data: string) => { fs.writeFileSync(p, data, 'utf-8'); },
    renameSync: (from: string, to: string) => { fs.renameSync(from, to); },
    mkdirSync: (p: string) => { fs.mkdirSync(p, { recursive: true }); },
    now: () => Date.now(),
    cachePath: defaultCachePath()
};

function isEntry(value: unknown): value is WidthCacheEntry {
    if (typeof value !== 'object' || value === null) {
        return false;
    }

    const entry = value as Record<string, unknown>;
    return (typeof entry.width === 'number' || entry.width === null)
        && typeof entry.createdAt === 'number';
}

function readCache(deps: WidthCacheDeps): PersistentWidthCache {
    const empty: PersistentWidthCache = { version: CACHE_SCHEMA_VERSION, entries: {} };
    try {
        const parsed = JSON.parse(deps.readFileSync(deps.cachePath)) as unknown;
        if (typeof parsed !== 'object' || parsed === null) {
            return empty;
        }

        const data = parsed as { version?: unknown; entries?: unknown };
        if (data.version !== CACHE_SCHEMA_VERSION || typeof data.entries !== 'object' || data.entries === null) {
            return empty;
        }

        const entries: Record<string, WidthCacheEntry> = {};
        for (const [key, value] of Object.entries(data.entries)) {
            if (isEntry(value)) {
                entries[key] = value;
            }
        }

        return { version: CACHE_SCHEMA_VERSION, entries };
    } catch {
        // Missing or corrupt cache is a miss, never a failure.
        return empty;
    }
}

/**
 * Read a cached width for this session.
 *
 * Returns null on miss/expiry/corruption, or a wrapper on hit. The wrapper
 * matters: a cached width of `null` means "we probed and there is no TTY",
 * which is a legitimate hit. Collapsing that to a bare null would make the
 * no-TTY case -- the expensive one -- re-probe on every render.
 *
 * ttlSeconds of 0 disables the cache (always a miss). NOTE: this differs from
 * gitCacheTtlSeconds, where 0 means "never expire". Divergence is intentional.
 */
export function readCachedWidth(
    sessionId: string,
    ttlSeconds: number,
    deps: WidthCacheDeps = defaultDeps
): { width: number | null } | null {
    if (ttlSeconds <= 0) {
        return null;
    }

    const entry = readCache(deps).entries[sessionId];
    if (!entry) {
        return null;
    }

    if (deps.now() - entry.createdAt > ttlSeconds * 1000) {
        return null;
    }

    return { width: entry.width };
}

/** Persist a probed width (including a null "no TTY" result). Best-effort; never throws. */
export function writeCachedWidth(
    sessionId: string,
    width: number | null,
    deps: WidthCacheDeps = defaultDeps
): void {
    try {
        const now = deps.now();
        const cache = readCache(deps);

        for (const [key, entry] of Object.entries(cache.entries)) {
            if (now - entry.createdAt > PRUNE_AFTER_MS) {
                delete cache.entries[key];
            }
        }

        cache.entries[sessionId] = { width, createdAt: now };

        deps.mkdirSync(path.dirname(deps.cachePath));
        const tempPath = `${deps.cachePath}.${process.pid}.tmp`;
        deps.writeFileSync(tempPath, JSON.stringify(cache));
        deps.renameSync(tempPath, deps.cachePath);
    } catch {
        // Best-effort cache; the statusline must render regardless.
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/utils/__tests__/terminal-width-cache.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Add the setting**

In `src/types/Settings.ts`, directly below `gitCacheTtlSeconds` (line 71):

```typescript
    // 0 disables the cache (always probe). Note this differs from
    // gitCacheTtlSeconds above, where 0 means "never expire".
    terminalWidthCacheTtlSeconds: z.number().min(0).max(300).default(5),
```

In `src/types/RenderContext.ts`, below `gitCacheTtlSeconds?: number;` (line 46):

```typescript
    terminalWidthCacheTtlSeconds?: number;
```

- [ ] **Step 6: Wire the cache into `getTerminalWidth`**

In `src/utils/terminal.ts`, widen the exported function and consult the disk cache around the probe:

```typescript
import {
    readCachedWidth,
    writeCachedWidth
} from './terminal-width-cache';

export interface TerminalWidthOptions {
    sessionId?: string;
    ttlSeconds?: number;
}

// Get terminal width
export function getTerminalWidth(options?: TerminalWidthOptions): number | null {
    if (hasProbed) {
        return cachedWidth;
    }

    const sessionId = options?.sessionId;
    const ttlSeconds = options?.ttlSeconds ?? 0;

    // L2: another process in this session may have already paid for the probe.
    if (sessionId) {
        const cached = readCachedWidth(sessionId, ttlSeconds);
        if (cached) {
            cachedWidth = cached.width;
            hasProbed = true;
            return cachedWidth;
        }
    }

    cachedWidth = probeTerminalWidth();
    hasProbed = true;

    if (sessionId && ttlSeconds > 0) {
        writeCachedWidth(sessionId, cachedWidth);
    }

    return cachedWidth;
}
```

In `src/ccstatusline.ts`, pass the session and TTL at the single entry-point probe (line ~170):

```typescript
        terminalWidth: getTerminalWidth({
            sessionId: data.session_id,
            ttlSeconds: settings.terminalWidthCacheTtlSeconds
        }),
```

and add to the same context object literal:

```typescript
        terminalWidthCacheTtlSeconds: settings.terminalWidthCacheTtlSeconds,
```

The zero-arg callers in `renderer.ts` and `widgets/TerminalWidth.ts` need no change: by the time they run, `hasProbed` is true and they read the memo.

- [ ] **Step 7: Run the full suite**

Run: `bun test`
Expected: PASS.

Run: `bun run lint`
Expected: clean.

- [ ] **Step 8: Verify cross-process sharing end-to-end**

```bash
bun run build
rm -f ~/.cache/ccstatusline/terminal-width.json
cat scripts/payload.example.json | node dist/ccstatusline.js >/dev/null
cat ~/.cache/ccstatusline/terminal-width.json   # entry keyed by session_id
# second render within the TTL must not probe at all:
cat scripts/payload.example.json | strace -f -e trace=execve -o /tmp/cached.log node dist/ccstatusline.js >/dev/null
grep -c execve /tmp/cached.log
```
Expected: the cache file contains one entry keyed by the payload's `session_id`; the second render's execve count is `1` (node itself).

- [ ] **Step 9: Commit**

```bash
git add src/utils/terminal-width-cache.ts src/utils/__tests__/terminal-width-cache.test.ts src/utils/terminal.ts src/types/Settings.ts src/types/RenderContext.ts src/ccstatusline.ts
git commit -m "feat: persist terminal width across renders and sessions

Adds ~/.cache/ccstatusline/terminal-width.json, keyed by session_id (width
is per-terminal, so a global value would be wrong), TTL'd by the new
terminalWidthCacheTtlSeconds setting (default 5s, 0 disables). Atomic
tmp+rename writes, entries pruned after an hour, corruption treated as a
miss. Cached nulls are hits, so the no-TTY case stops re-probing."
```

---

### Task 5: Measure the result and document the setting

**Files:**
- Modify: `README.md` (the settings/configuration table where `gitCacheTtlSeconds` is documented)
- Create: `docs/superpowers/plans/2026-07-13-statusline-render-cost-results.md`

**Interfaces:**
- Consumes: everything above. Produces no code.

- [ ] **Step 1: Document the setting**

Find the section of `README.md` documenting `gitCacheTtlSeconds` (`grep -n gitCacheTtlSeconds README.md`) and add an adjacent entry:

```markdown
| `terminalWidthCacheTtlSeconds` | `5` | How long a probed terminal width is reused, in seconds (0–300). The width probe is the single most expensive thing ccstatusline does, so the result is cached per session in `~/.cache/ccstatusline/terminal-width.json` and shared across renders. Set to `0` to disable caching and probe on every render. If you resize your terminal, the status line corrects itself within this many seconds. |
```

- [ ] **Step 2: Re-measure spawn count against the pre-change baseline**

```bash
bun run build
cat scripts/payload.example.json | strace -f -e trace=execve -o /tmp/final.log node dist/ccstatusline.js >/dev/null 2>&1
grep -c execve /tmp/final.log
```
Baseline was **113**. Expected now: **1** (node itself) on a cache hit, and 1 on a cache miss on Linux (the native probe spawns nothing).

- [ ] **Step 3: Re-measure real-world CPU with the sampler**

The 2h sampler used for the baseline reads `/proc` every 50ms and sums CPU per matching process. Re-run it against the rebuilt binary for at least 20 minutes of normal use, then compare:

| Metric | Baseline | Target |
| --- | --- | --- |
| execve per render | 113 | 1 |
| Mean CPU per render | 1.30 CPU-s | 0.1–0.3 CPU-s |
| Share of a 6-core machine | 11.2% | ~1–2% |

Write the actual observed numbers into `docs/superpowers/plans/2026-07-13-statusline-render-cost-results.md`. **Report what you measure, not what was predicted** — if the improvement is smaller than the target, say so and profile again (`node --cpu-prof`) to find what now dominates.

- [ ] **Step 4: Confirm correctness, not just speed**

```bash
script -qc "stty size" /dev/null                       # ground truth "rows cols"
script -qc "cat scripts/payload.example.json | node dist/ccstatusline.js" /dev/null
```
Expected: the rendered status line uses the true column count from `stty size`. Before this change, the `tput` fallback reported 80.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/superpowers/plans/2026-07-13-statusline-render-cost-results.md
git commit -m "docs: document terminalWidthCacheTtlSeconds and record measured results"
```

---

## Deferred to a follow-up PR (do NOT do it in this one)

**Lazy-load the TUI.** `src/ccstatusline.ts` line 4 statically imports `runTUI` from `./tui`, so React 19 + Ink 6 are parsed and evaluated on every render despite only being needed for interactive config (~0.5–1 CPU-s/render; it is why the bundle is 3.16MB). The fix is a dynamic `await import('./tui')` inside the interactive branch, which requires the build to emit chunks (`bun build --splitting --outdir dist`) instead of a single `--outfile`. That changes the shape of the published artifact, so it ships separately from these pure-win width fixes, per the approved spec.

## PR notes

Open as a draft PR against the fork. The description must state:
- The measured baseline (113 execve/render; 4,845 CPU-s over 2h across 2,972 renders; 11.2% of a 6-core box) and the measured after-numbers from Task 5.
- That the old `tput` fallback returned a **wrong** width (80) where the new probe returns the true one (209) — this is a correctness fix, not only a perf fix.
- The deliberate TTL-semantics divergence from `gitCacheTtlSeconds` (`0` = always probe here; `0` = never expire there).
