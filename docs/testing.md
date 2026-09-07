# Testing Guide

This is the shared test contract for Adam contributors. Use it with the [engineering instructions](../AGENTS.md) and the active task's acceptance requirements.

## Choose evidence that fits the change

- Identify the observable behavior and the module interface, command, snapshot, event, or process result that proves it. Reuse the narrowest existing interface that exposes the result; routine test selection within accepted scope does not need separate approval.
- Reproduce a defect before repairing it and retain meaningful regression evidence. For a behavior change, add or update tests where existing coverage does not establish the requested result. Choose an incremental implementation cadence appropriate to the risk; a task that explicitly requires test-first or ordered RED/GREEN retains that requirement.
- Documentation, formatting, wiring with no observable behavior, mechanical refactors, and purely visual changes need proportionate checks rather than an artificial failing test. Use existing behavior checks for refactors and inspect the rendered result when appearance changes.
- Expected values must come from independent worked literals, hand-authored fixtures, or an accepted external contract. Do not test private state, internal call order, or production helpers against their own output, and do not mock Adam-owned modules. Fake external providers, clocks, processes, filesystems, MCP transports, and Web sources only at their actual adapter interfaces.
- Keep fixtures limited to the active behavior. Avoid speculative future-case suites and adapters; each retained test must detect a meaningful failure independently, without suite-order dependence or shared mutable live fixtures. Related examples of one behavior may share a parameterized test or a focused suite run; do not turn every assertion into a separate implementation cycle.

## Deterministic behavior and external contracts

Keep semantic tests below expensive OS adapters. Use deep in-process owners and deterministic adapters for lifecycle policy, catalog projection, Presentation snapshots, renderer state, and provider ordering, rejection, cancellation, malformed output, compaction, and retry behavior.

Real JSONL/fsync, crash, path confinement, child-process, shell cancellation/signals, MCP stdio, PTY, and terminal-restoration tests must prove a unique external contract. Keep their ownership in explicit `.os.test.ts` suites; use a virtual terminal for ordinary rendering behavior and real PTY/terminal coverage where resize, bracketed paste, wide-character input, permission prompts, interrupt, or cleanup depends on the terminal adapter itself. Live provider, Web, and external MCP checks remain opt-in; ordinary CI requires no credentials or external network.

When moving an existing test to a cheaper seam, preserve its inputs, observable outcomes, and failure classification. Test names, helper names, file locations, import lists, and test counts are not product contracts. Run the relevant old and new cases to establish equivalence before removing a redundant external fixture. Preserve the approximately 46.875 MiB encoded-record regression when changing large-output fixture construction; its opt-in command is `pnpm test:large-output`.

Keep small structural checks only for a concrete dependency, authority, or public API boundary that behavior or type checks do not already cover. Do not snapshot source spelling, complete import lists, declarations, constructor counts, test inventories, or CI script text. Document publication requirements in the workflow rather than duplicating its implementation in tests.

## Causal synchronization and resource ownership

- Synchronize on complete frames or stream output, exact runtime events, IPC, durable reads, effects, or child closure. Polling intervals, arbitrary sleeps, elapsed-time assertions, and wait-then-assert-absence are not success criteria. Timeouts are centralized, bounded failure/cleanup guards that report the missing causal state. Inner observation guards should fail before the runner deadline, leaving time for cleanup. Adjust test budgets or concurrency only from measured resource needs while retaining the same behavior assertions; never use delays or retries to hide an ordering defect.
- Test deadline and backoff policy with a fake clock. Use real time only for an explicit timer or OS adapter contract without a causal fake-clock seam; block fixtures on events or open streams instead of finite sleeps.
- Treat inherited process environment as adapter input. A harness owns and restores capability variables such as `NO_COLOR` and `TERM` for its full lifetime; check both relevant inherited states when local and hosted environments may differ.
- Only child `close` proves external-process reclamation. An `error` event reports failure without releasing ownership. Failure guards reject the caller directly; cleanup is bounded and single-flight through TERM then KILL; consume every background cleanup rejection and retain active tracking until close.
- Filesystem notifications are wake-ups, not durable truth. Install the watcher before triggering the producer, reread the exact target after directory events even when filenames are absent or coalesced, and settle only from the expected durable contents or explicit producer failure.

## Checks and failure diagnosis

Use `pnpm test <test-file> [more test files]` for one build followed by a focused suite. Add `-t '<test name>'` to isolate a failure; after a fix, run the relevant behavior group instead of repeatedly launching every example separately. This existing command refreshes project references before cross-package tests consume `dist`. When only tests or directly imported components changed and package output is already current, `pnpm exec vitest run <test-file>` needs no separate build. Evidence against stale generated output is invalid.

The virtual terminal separates current-screen observations (`waitForScreen`) from a complete frame after an action checkpoint (`waitForFrameAfter`). Recorded output is a historical query, not proof that a target is currently actionable. Use the managed TUI fixture's `openFirstAgent` to wait for each visible selection before Enter; keep raw input only when the input protocol itself is under test. Empty expected text is an error.

Review the final diff against the requested behavior and engineering rules. Run the complete Linux `pnpm quality:check` before a product PR and require hosted `quality` before merge. A later product change requires a fresh full candidate check; otherwise, repeat only when a failure, unresolved concern, or explicit task gate justifies it. Do not use full Quality as the inner development loop.

For a hosted timeout or unexplained failure, inspect the failing test and resource owner before calling it flaky. Use independent exact-name runs and the owning test file; add a concurrent reproduction and historical CI comparison when contention or environment differences are plausible. Rerun an unchanged head only when the evidence supports that diagnosis. Repeated failures require inspecting the shared fixture and the action prerequisite before adding more case-specific waits. Repair the cause; keep product assertions intact. Performance measurements guide engineering decisions but are not CI latency thresholds unless an explicit product performance contract requires one.

## Representative responsiveness workload

`pnpm test apps/tui/src/responsiveness.os.test.ts` builds a synthetic 88-Skill catalog, 41 provider requests, four Todos and two live children. It exercises current production navigation and the candidate Control path through complete frames, including return to Main. Both representative paths use the production JSONL SessionStore so the workload includes verified-prefix reuse and actual filesystem durability; small semantic Fleet tests retain the mutable in-memory adapter. Set `ADAM_RESPONSIVENESS_REPORT=/tmp/production-frames.json` and `ADAM_CONTROL_RESPONSIVENESS_REPORT=/tmp/control-frames.json` to retain local timing samples. Compare the same fixture and environment across revisions; the samples are diagnostic measurements, not CI latency thresholds.

The ordinary Enter admission test blocks at the durable run boundary and checks a fresh pending frame before releasing provider dispatch. Store invalidation tests in `session-store-failure.os.test.ts` cover changed byte prefixes, gaps, incomplete tails and recovery after warm reads. Reused validation is limited to deeply immutable values; mutable adapter snapshots retain full validation.

The text-read OS suite exercises large-file line selection, bounded source scanning, UTF-8/BOM pagination, changed-file rejection, cancellation, and interrupted historical adapter recovery under Plan. Atomic Todo suites cover full-candidate dependency validation, permission decisions, durable commit boundaries, compaction and branch recovery; the TUI suite verifies the resulting compact status and read-only navigator through fresh frames.
