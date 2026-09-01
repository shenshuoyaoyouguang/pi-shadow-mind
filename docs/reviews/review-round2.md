## Review

Second-round review of `pi-shadow-mind` at commit 221791f, read-only. Two passes: (1) full read of every file in the uncommitted diff plus the build/packaging files and all 15 test suites; (2) line-level verification of the 10 focus areas and the 14 round-1 findings. I have no shell access in this run, so I could not execute `git diff/show` or `npm run verify`; test status is taken from the task statement (GREEN, 15 files / 119 tests) and cross-checked against what the tests assert in source. The working tree was not mutated.

### Strengths

- **Round-1 fixes are real, not test-only.** Spot-verified at source: `runReason` report-preference (src/shadow-runner.ts:118-122), unanswered-toolCall metrics (src/shadow-runner.ts:214-233), feedback bounding (src/trajectory.ts:10-13, 52-63), preview cap (src/summaries.ts:57-61), pause epoch-bump + guards (src/runtime.ts:196, 207, 333-340), watchdogs (src/runtime.ts:272-306), heartbeat serialization (src/runtime.ts:151-154), lifetime stale-ctx containment (src/session-lifetime.ts:22-31), extraFields round-trip (src/config.ts:24-48, src/registry.ts:105-112, src/entity-store.ts:37-40).
- **New tests exercise real behavior.** `test/entity-store.test.ts` uses real fs in `mkdtemp` dirs (create/update/delete/duplicate/external-delete idempotency); `test/runtime.test.ts` mocks only the Pi boundary (`createAgentSession`, `getAgentDir`) and runs real config parsing, registry, scheduler, batcher, lifetime, and watchdog timers (including a 25 ms grace and a 0.05 s headless drain); `test/management-tools.test.ts` runs real TypeBox `Value.Check` and real `execute()` calls. The pause-mid-heartbeat test (test/runtime.test.ts:216-227) injects the pause through `sessionManager.getEntries()`, which is a genuinely nasty interleaving to cover.
- **Build invariants are airtight in practice** (scripts/build.mjs): the metafile external check covers re-exported externals (esbuild emits them as import entries with the `external` flag), the `__require(` check catches CJS shims, the `dist` listing check also catches stale files (clean is not required first), and the trailing native-ESM `import` executes the entry top level and resolves all peer deps (src/index.ts → runtime.ts → the `@earendil-works/*` packages are actually imported). `smoke-standalone.mjs` matches AGENTS.md step 5 exactly, including the `noExtensions: true` + `additionalExtensionPaths` + `PI_CODING_AGENT_DIR` sandboxing, and it verifies real registration (8 tools, `/shadow`, `Alt+S`).
- **Ownership/composition stays clean** (AGENTS.md): `src/index.ts` is a 6-line composition; the watchdog/epoch/batching concerns live in their owning modules; `sample()` and `matchesModel` changes are minimal and pinned by new tests (test/scheduler.test.ts:59-71, 73-83).
- `package.json`/lockfile are consistent with the publishing invariants: `type: module`, ESM-only `exports`, `yaml` is devDependency in both (package-lock.json:21, 4087-4090 `"dev": true`), `prepack` = verify + build.

### Round-1 findings — verification verdict

| # | Finding | Verdict |
|---|---|---|
| 1 | 22 failing tests | Fixed (per task: 119 green; tests read match new behavior) |
| 2 | Test gaps (store/tools/runtime) | Fixed — 3 new suites, real-behavior style (see Strengths) |
| 3 | Batcher fire-and-forget rejection | Fixed — src/report-batcher.ts:22 `void this.flush().catch(() => {})` + queue `run.catch` (src/report-batcher.ts:28-30). No direct unit test (see I3) |
| 4 | Stale ctx deactivated lifetime | Fixed + tested (src/session-lifetime.ts:22-31; test/session-lifetime.test.ts:13-21) |
| 5 | O(N) trajectory feedback | Fixed + tested (src/trajectory.ts; test/trajectory.test.ts:18-37) — but DESIGN.md not updated (I2) |
| 6 | Unbounded previews | Fixed + tested (PREVIEW_MAX_CHARS=200, src/summaries.ts:57) |
| 7 | runReason timeout-vs-report | Fixed + tested (test/runner.test.ts "report-then-hang") |
| 8 | toolMetrics undercount | Fixed + tested (matched by toolCallId; test/tools.test.ts:41-55) |
| 9 | chars/2 estimate | Fixed — (chars/4)×1.1 with both boundary tests (test/runner.test.ts:170-186) |
| 10 | update() drops extraFields | Fixed for shadow markdown + config parse/serialize — but a new drop path was introduced in `update_shadow_config` (I1) |
| 11 | Raw fs errors with paths | Partial — POSIX paths redacted; Windows backslash paths are not (I4) |
| 12 | Pause microtask re-arm | Fixed + tested (epoch bump is synchronous in `setPaused`; both guards in place; test/runtime.test.ts:229-251) |
| 13 | Aborted run slot leak | Fixed + tested — with a shutdown disarming caveat (I5) |
| 14 | Oversubscribed slots | Fixed + tested (serialized chain; test/runtime.test.ts:197-202) |

### Issues

#### Critical (Must Fix)

**C1 — `EntityStore.create` uses `fs.promises.link` (hardlink), which fails for non-elevated Windows users.**
`src/entity-store.ts:135` — the non-overwrite path of `atomicWriteFile` creates the target via `link(tmpPath, filePath)`. On Windows, creating hard links (`CreateHardLink`) requires `SeCreateSymbolicLinkPrivilege` ("Create symbolic links" user right), which by default is only held by Administrators; other users get `EPERM`. This product's stated runtime is Windows, and `create_shadow` is the core onboarding path, so a standard (non-admin) user's first `create_shadow` will fail with an EPERM that `sanitizedError` can only redact, not fix. The new tests pass in this checkout only if the dev session happens to run elevated — which the green suite here suggests. The standalone smoke test cannot catch this: it only checks registration, never invokes create.
- EXDEV is *not* a real risk (tmp is created in the target's own directory, same volume — focus area 3 answered).
- Fix: claim the target with `open(filePath, "wx")` (O_EXCL works without privileges on all platforms), then `copyFile(tmpPath, filePath)` and unlink tmp; keep the `EEXIST` → "already exists" mapping in `writeParsed`. Optionally keep `link` as a fast path with an EPERM fallback.
- Verify before release: run `create_shadow` (or a one-line `fs.promises.link` probe) in a non-elevated Windows session.

#### Important (Should Fix)

**I1 — `update_shadow_config` silently drops `extraFields` from `config.json`.**
`src/management-tools.ts:117-126` rebuilds the config from exactly the 9 known keys (`raw.x ?? current.x`), so `parseConfig` sees no unknown keys and `next.extraFields` is undefined; `writeConfig` → `serializeConfig` (src/config.ts:58-70, `config.extraFields ?? {}`) then rewrites the file without the user's unknown keys. This is the same class of bug as round-1 finding 10, which the round-trip fix in `parseConfig`/`serializeConfig` (and the tests in test/config.test.ts:21-33) explicitly closed for the read/parse path — but the tool's write path bypasses it, and no test covers it. Fix: spread `...(current.extraFields ?? {})` into the `parseConfig` input (or copy `extraFields` onto `next`), plus a test that writes a config with an unknown key, calls the tool, and re-reads the file.

**I2 — DESIGN.md still documents the unbounded feedback chain the code now bounds.**
`src/trajectory.ts:4-9`'s comment claims "DESIGN.md §6 keeps the feedback chain, just bounded", but DESIGN.md §4 ("保留的消息内容包括：…已注入 Main 会话的历史 `shadow-report`") and §6 ("历史 `shadow-report` 会进入后续 Shadow 的净化轨迹，形成显式反馈链") describe *all* historical reports entering the trajectory. The new behavior (most recent ≤3 reports within 4000 chars, older ones replaced by an omission marker) is a behavior-contract change, and AGENTS.md designates DESIGN.md as that contract. Update §4/§6 to state the bound and the marker. (README.md's "How it works" makes no claim about the feedback chain, so no README change is strictly required for this; error redaction and report-vs-timeout classification are internal semantics the README never documents. The README's install line, however, still pins `0.1.11` while `package.json` is `0.1.14` — see M6.)

**I3 — The new `ReportBatcher` behaviors have no direct unit tests.**
test/report-batcher.test.ts contains only the original window-combination test. The round-2 changes — serialized `flush()` through the promise queue (src/report-batcher.ts:27-31), rejection containment in the timer callback (line 22), `clear()` returning the dropped count (lines 51-57) — are each load-bearing for round-1 finding 3 and the pause fix, yet none is directly tested (the runtime tests exercise `clear()` indirectly via pause, but never a rejecting `deliver` or overlapping deliveries). Add ~3 small fake-timer tests: rejecting deliver doesn't reject the chain or leak a rejection; two queued deliveries run one at a time; `clear()` returns the pending count and `hasPending` reflects an in-flight delivery (`deliveries > 0`).

**I4 — `sanitizedError` does not redact Windows backslash paths.**
`src/management-tools.ts:170` — `/['"]?\/[^'"\s]*['"]?/g` only matches forward-slash tokens. Node fs error messages on Windows carry the path as passed, i.e. with backslashes (`ENOENT: no such file or directory, open 'D:\AI\...\config.json'`), so absolute Windows paths still reach the model — the exact leak round-1 finding 11 aimed to close, on this project's primary OS. The new test (test/management-tools.test.ts:57-79) only uses `/tmp/...` and `/abs/path`, which is why the suite is green. Under-redaction is the main problem; note the current regex also over-redacts bare `/` (e.g. `1/2` → `1<path>2`), and the second replacement (`/\n.*at\s+.*$/s`) can truncate legitimate multi-line messages containing "at ". Fix: two anchored alternatives — drive-letter+backslash (`/[A-Za-z]:\\[^\s'"]*/g`) and POSIX absolute path (`/(?:^|[\s(])['"]?\/[^\s'"]*['"]?/g`) — deliberately *not* a generic quoted-string rule, which would mangle domain errors like `shadow 'dup' already exists`. Add a Windows-path test case.

**I5 — Shutdown disarms the watchdogs, defeating the round-1 finding 13 backstop across TUI session replacement; timers are not `unref`'d.**
`src/runtime.ts:95-96` — `session_shutdown` calls `abortAll` (which arms a 5 s watchdog per active run, line 280) and then immediately `disarmWatchdogs()`. The arm-then-disarm is dead weight, and it matters: the runtime persists across TUI session replacement (the stale-ctx path proves it), so an aborted run whose `waitForIdle` never settles — the failure round 1 actually observed — keeps its `active` slot leaked into the replacement session until the next `input`/`pause` event re-arms it (self-heals, but with a reduced parallel quota in between). In headless mode the process exits, so it's harmless there. Separately, the timers at src/runtime.ts:290 (and the runner's own timeout at src/shadow-runner.ts:174) are not `unref`'d; today every armed timer is cleared before shutdown so headless exit is unaffected, but that invariant is fragile — any future path that leaves a watchdog armed would hold `pi -p` up to 5 s. Fix: `timer.unref()` in `armWatchdog` and stop disarming at `session_shutdown` (with `unref`, armed-but-expired-safe watchdogs no longer delay exit and the backstop survives session replacement).

#### Minor (Nice to Have)

- **M1 — Duplicated `atomicWriteFile`.** src/config.ts:152-157 (rename-only) and src/entity-store.ts:129-145 (link/rename + `overwrite` option). With C1's fix converging the two to one algorithm, extract a single helper (e.g. `src/atomic-file.ts`, or exported from a small `fs` module) taking `{ overwrite }`. (entity-store already imports from config.js, but config.ts is the wrong owner for generic file I/O.)
- **M2 — Tmp file leak on crash.** Both atomic-write copies leave `.<name>.<ts>-<rand>.tmp` behind if the process dies between `writeFile` and `link`/`rename` (src/entity-store.ts:130-141, src/config.ts:153-156). Low risk (unique names, hidden files); optionally sweep stale `*.tmp` during `ConfigStore.initialize()`/`ShadowRegistry.initialize()`.
- **M3 — Redundant catch in the hardlink branch.** src/entity-store.ts:137-141: `if (EEXIST) throw error; throw error;` — both arms identical; collapse to a single `throw error` (keep the tmp-cleanup `unlink`).
- **M4 — Multi-line text in the plain trajectory produces unlabeled continuation lines.** `appendText`/the `SHADOW FEEDBACK` push in src/trajectory.ts:66-96 keep embedded newlines from user messages, main text, and multi-line reports; a two-line report renders as `SHADOW FEEDBACK: line1` then a bare `line2` in a line-oriented transcript. Consider flattening newlines in `extractText`-derived text (as `compact()` already does for previews).
- **M5 — Tool schemas omit `thinking_level: "off"`.** `THINKING` in src/management-tools.ts:12 lists `minimal…max`, but the canonical set in src/validation.ts:3 (and the registry parser, test/registry.test.ts:25-30) accepts `off`. The agent can't set `off` even though the file format allows it; reuse `THINKING_LEVELS` to build the union.
- **M6 — README install pin stale.** Fixed: README.md (both English and 中文 sections) now says `pi install npm:pi-shadow-mind@0.2.0`, matching package.json's `0.2.0`.
- **M7 — `.omo/` is untracked and not gitignored.** Fixed: `.omo/` is now in the repo `.gitignore` (line 7).
- **M8 — Heartbeat rejection handling relies on the Pi framework.** `onHeartbeat` returns the unhandled-protected `next` to the `turn_end` handler (src/runtime.ts:151-154); the chain itself is safe, and a rejecting `runHeartbeat` (e.g. `readdir` EACCES inside `registry.load`) is only handled if Pi catches async handler rejections. If Pi doesn't, consider `next.catch(err => this.record("heartbeat-error", {...}))` before returning.
- **M9 — `delete_shadow` on an unparseable shadow can report false success.** If a file fails frontmatter parsing it's absent from the registry, so `EntityStore.delete` falls back to unlinking `<id>.md` (src/entity-store.ts:75-86); if the user's file has a different name, the fallback misses, `ENOENT` is swallowed, and the tool reports "Deleted …" while the file remains. Edge case; consider scanning registry diagnostics for a matching path, or reporting "not found" when the fallback unlink hits nothing.
- **M10 — Build hardening nit.** scripts/build.mjs:31-33 treats only the exact string `typebox` as allowed; a future `import ... from "typebox/value"` would fail the external check rather than being recognized (it would be bundled instead, violating the peer-dependency assumption). Use `path === "typebox" || path.startsWith("typebox/")`.
- **M11 — Empty-report tool reply is slightly a lie.** When `report_to_main` gets whitespace-only content, the callback drops it (src/shadow-runner.ts:232) but the tool still returns "Report delivered." with `terminate: true`. Cosmetic, model-facing; "Report ignored (empty)." would be truer.
- **M12 — Marker grammar.** "(1 older reports omitted)" (src/trajectory.ts:79) — singular/plural, purely cosmetic.

### Recommendations

1. Fix C1 before any release (it breaks the primary user path on default Windows); replace the hardlink with an O_EXCL claim + copy, and add a non-elevated Windows verification step to the release checklist.
2. Bundle I1 + I4 into one small "config/paths" patch with tests (both are one-liner fixes with a regression test each); fix I2 by editing DESIGN.md §4/§6 to state the feedback bound; add the three batcher unit tests (I3).
3. Apply the watchdog `unref` + no-disarm-at-shutdown change (I5) while touching runtime.ts, and re-run the runtime suite — the existing tests should pass unchanged.
4. When cutting the next version, bump the README install line in both languages (M6) and add `.omo/` to `.gitignore` (M7).

### Assessment

**Ready to merge?** With fixes.
**Reasoning:** The round-2 work is high quality and all 14 round-1 findings are genuinely addressed in code and tests, but the hardlink-based create is very likely broken for non-elevated Windows users (C1), `update_shadow_config` silently drops user config keys (I1), and the error-redaction gap on Windows paths (I4) plus the DESIGN.md contract drift (I2) should be closed before this ships.

Commands the supervisor should run (I have no shell access): `npm run verify` (confirm 119/119 after any fixes), `git status --porcelain` and `git diff --cached --name-only` (confirm no staged files), and a non-elevated-Windows probe: `node -e "const {writeFile,link,rm}=require('fs/promises');(async()=>{await writeFile('a','');await link('a','b');await rm('a');await rm('b')})().then(()=>console.log('ok')).catch(e=>console.log(e.code))"` in an empty temp dir.