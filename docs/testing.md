# Testing Guide

This is the shared test contract for Adam contributors. Use it with the [engineering instructions](../AGENTS.md) and the active task's acceptance requirements.

## Choose evidence that fits the change

- Identify the observable behavior and the module interface, command, snapshot, event, or process result that proves it. Reuse the narrowest existing interface that exposes the result; routine test selection within accepted scope does not need separate approval.
- Reproduce a defect before repairing it and retain meaningful regression evidence. For a behavior change, add or update tests where existing coverage does not establish the requested result. Choose an incremental implementation cadence appropriate to the risk; a task that explicitly requires test-first or ordered RED/GREEN retains that requirement.
- Documentation, formatting, wiring with no observable behavior, mechanical refactors, and purely visual changes need proportionate checks rather than an artificial failing test. Use existing behavior checks for refactors and inspect the rendered result when appearance changes.
- Expected values must come from independent worked literals, hand-authored fixtures, or an accepted external contract. Do not test private state, internal call order, or production helpers against their own output, and do not mock Adam-owned modules. Fake external providers, clocks, processes, filesystems, MCP transports, and Web sources only at their actual adapter interfaces.
- Keep fixtures limited to the active behavior. Avoid speculative future-case suites and adapters; each retained test must detect a meaningful failure independently under focused name selection, without suite-order dependence, shared live `beforeAll` state, or several semantic cases batched behind one external process.

## Deterministic behavior and external contracts

Keep semantic tests below expensive OS adapters. Use deep in-process owners and deterministic adapters for lifecycle policy, catalog projection, Presentation snapshots, renderer state, and provider ordering, rejection, cancellation, malformed output, compaction, and retry behavior.

Real JSONL/fsync, crash, path confinement, child-process, shell cancellation/signals, MCP stdio, PTY, and terminal-restoration tests must prove a unique external contract. Keep their ownership in explicit `.os.test.ts` suites; use a virtual terminal for ordinary rendering behavior and real PTY/terminal coverage where resize, bracketed paste, wide-character input, permission prompts, interrupt, or cleanup depends on the terminal adapter itself. Live provider, Web, and external MCP checks remain opt-in; ordinary CI requires no credentials or external network.

When moving an existing test to a cheaper seam, preserve its name, input, observable outcome, and failure classification. Run old and new cases to establish equivalence before removing the redundant external fixture. Preserve the approximately 46.875 MiB encoded-record regression when changing large-output fixture construction; its opt-in command is `pnpm test:large-output`.

Maintain structural guards against forbidden direct process ownership, suite-local timing policy, Adam-module mocks, duplicate exact test names, changed-path Quality skips, and extra optional Quality jobs. A passing duration threshold, larger timeout, worker cap, reduced coverage, or weaker assertion cannot repay test-architecture debt.

## Causal synchronization and resource ownership

- Synchronize on complete frames or stream output, exact runtime events, IPC, durable reads, effects, or child closure. Polling intervals, arbitrary sleeps, elapsed-time assertions, and wait-then-assert-absence are not success criteria. Timeouts are centralized, bounded failure/cleanup guards that report the missing causal state.
- Test deadline and backoff policy with a fake clock. Use real time only for an explicit timer or OS adapter contract without a causal fake-clock seam; block fixtures on events or open streams instead of finite sleeps.
- Treat inherited process environment as adapter input. A harness owns and restores capability variables such as `NO_COLOR` and `TERM` for its full lifetime; check both relevant inherited states when local and hosted environments may differ.
- Only child `close` proves external-process reclamation. An `error` event reports failure without releasing ownership. Failure guards reject the caller directly; cleanup is bounded and single-flight through TERM then KILL; consume every background cleanup rejection and retain active tracking until close.
- Filesystem notifications are wake-ups, not durable truth. Install the watcher before triggering the producer, reread the exact target after directory events even when filenames are absent or coalesced, and settle only from the expected durable contents or explicit producer failure.

## Checks and failure diagnosis

Refresh relevant TypeScript project references or package builds before focused cross-package tests consume generated output. Evidence against stale `dist` is invalid; rebuild and rerun the affected checks. Iterate with focused tests, then check the complete owning package or external-contract suite when the change warrants it.

Review the final diff against the requested behavior and engineering rules. Run the complete Linux `pnpm quality:check` before a product PR and require hosted `quality` before merge. A later product change requires a fresh full candidate check; otherwise, repeat only when a failure, unresolved concern, or explicit task gate justifies it. Do not use full Quality as the inner development loop.

For a hosted timeout or unexplained failure, inspect the failing test and resource owner before calling it flaky. Use independent exact-name runs and the owning test file; add a concurrent reproduction and historical CI comparison when contention or environment differences are plausible. Rerun an unchanged head only when the evidence supports that diagnosis. Repeated or caller-visible failures require causal repair, not timeout, worker, assertion, or coverage changes.
