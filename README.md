# Adam Agent

Adam Agent is a lightweight, inspectable TypeScript coding agent for local software-engineering work.

The repository contains a provider-neutral Agent kernel with four model-facing coding tools (`read_file`, `write_file`, `edit_file`, and `run_shell`), call-scoped permission requests, canonical event persistence through caller-supplied in-memory and durable project-scoped JSONL stores, cancellation, bounded shell output with durable content-addressed overflow artifacts, and per-run turn/token limits. `write_file` is create-only, while `edit_file` accepts one bounded operations-only patch containing declarative create, exact update, ordinary-text delete, and move operations. Adam binds the normalized patch to one multi-path write approval with a SHA-256 digest, completes all semantic preflight before commit, and uses same-filesystem staging plus compensating rollback for ordinary in-process I/O failures. A rollback failure is reported as `patch_state_uncertain` with affected paths and an opaque reference to owner-only recovery data. A recovery-cleanup failure instead reports whether the workspace is known to be committed or rolled back and tells the caller not to retry automatically; neither result is a crash-safe or cross-path atomic filesystem guarantee.

A deterministic fake model remains the default, while an environment-selected OpenAI-compatible Adapter provides the first live DeepSeek path. Filesystem path confinement rejects traversal and symlink escape, while approved shell commands run from the project root with a minimal environment and mandatory timeout/process-group cleanup. Neither mechanism is an OS sandbox or network isolation boundary, and the shell must only be used for trusted local work after reviewing each command. New canonical session records use schema v2, while the reader continues to accept unchanged v1 records. Resume and an interactive terminal UI have not been added yet. The accepted runtime is Node.js 24 LTS with pnpm 11; Bun is reserved for a later compatibility-tested distribution experiment.

The repository also contains the independently packable `@adam-agent/extension-api` contract targeting its first supported `0.1.0` release and a trusted in-process Extension Host foundation. Package version `0.0.0-bootstrap.0` is reserved only to establish the npm package identity under the non-default `bootstrap` dist-tag; it is not a supported consumer release. The Host loads only explicitly configured package roots, validates locked identity, version, compatibility, capability grants, and confined ESM entry points before activation, publishes contribution registrations transactionally, and persists enable or disable state before changing visibility. Its project-scoped operation controller generates operation IDs and owns bounded input decoding, digest-scoped idempotency, deadlines, progress budgets, query, durable-replay-then-live events, cancellation, and exactly one terminal result. Valid encoded domain rejection remains a completed operation; Host, deadline, capability, persistence, invalid-output, and handler failures remain distinct infrastructure truth.

In-memory and owner-only append-only JSONL `OperationStore` Adapters share one strict v1 record contract with per-operation sequence validation, file synchronization before publication, and fail-closed reopen behavior. The JSONL Adapter rejects a project log above 256 MiB rather than reading an unbounded state file. The default deadline is 60 seconds, configurable by the Host up to five minutes, while an individual start may only tighten it. Inputs are limited to 12,000,000 encoded bytes, outputs to 5,000,000 bytes, JSON to depth 64 and 100,000 containers, and progress to 64 KiB per record, 256 records, and 1 MiB aggregate. Disabling an extension persists and blocks new work before signalling its active operations; a handler that misses the bounded grace period is reported as `disabled_with_pending_operations` without inventing a terminal result. Reopening a nonterminal log reports `operation_recovery_required` and never reruns or rewrites the operation; restart recovery belongs to a later checkpoint.

Three concrete operation capabilities are available only when declared, compatible, granted, and backed by their Host broker. `adam.artifact.publish@1` makes content-addressed bytes durable before returning a path-free summary, retains already-published summaries on any later terminal result, and limits an operation to eight artifacts, 8 MiB each and 16 MiB aggregate. `adam.storage.records@1` confines create-if-absent JSON records to a hashed canonical project and exact extension identity, provides get and bounded prefix pagination, and exposes no update, delete, transaction, or storage path. Records are limited to 6 MB each, sixteen creates and 8 MB aggregate per operation, and 256 MB per namespace. `adam.analyzer-execution.biome@1` accepts only UTF-8 file snapshots and the fixed `adam-biome-recommended-v1` profile; each process effect must also receive `allow` from the configured `PermissionPolicy`, while `ask`, `deny`, and policy failure all fail closed before execution. Its pinned Biome process runs in an isolated temporary tree with bounded files, report and diagnostic streams, deadline and cancellation propagation, and process-group cleanup. It accepts no executable, command, arguments, environment, or workspace path, and it does not turn Adam into a review engine.

Extension JavaScript runs with the Adam process's authority: this is not a package installer, marketplace, or security sandbox. Configured package roots are trusted mutable code; the Host validates their call-time state but does not snapshot them or contain concurrent same-user mutation. Adam composition owns one active Extension Host; operation, lifecycle, and store commands are serialized inside that process for orderly reopen and do not claim simultaneous shared-Host or cross-process coordination. The extension API package is not yet published to npm, and the default one-shot CLI deliberately remains unchanged and does not load extensions.

## Development

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm hooks:install
pnpm quality:check
pnpm --silent adam "What is this repository?"
```

With no provider environment variable, the `adam` command exercises deterministic read, edit, and shell scenarios through the fake provider. It asks on stderr before write or execute effects. Session and operation JSONL, overflow and extension artifacts, immutable extension records, extension lifecycle state, and private patch recovery data are written under `ADAM_AGENT_STATE_ROOT` when set, otherwise under `~/.local/state/adam-agent`. Recovery data is normally removed after a successful patch or complete rollback. If removal fails, Adam returns `patch_recovery_cleanup_failed` with the known `committed` or `rolled_back` settlement and an opaque reference to the cleanup attempt; because recursive removal may have partially completed, any remaining bundle is not guaranteed to be complete. Inspect the reference and workspace state before any retry. Recovery data is retained intact when Adam stops cleanup because it cannot confirm the workspace state, and this first version deliberately provides no automatic restart recovery.

To use the live DeepSeek Adapter locally, copy the tracked placeholder file, restrict its permissions, and add the credential to the ignored project-root `.env`:

```bash
cp .env.example .env
chmod 600 .env
# Edit .env and set DEEPSEEK_API_KEY, then run:
pnpm --silent adam "Summarize this repository"
```

Adam loads only `.env` from the current project root and ignores it through the repository's committed `.gitignore`; `.env.example` contains names and non-secret defaults only. Values already present in the process environment take precedence, so CI or a shell export can override the local file. The file is still plaintext local credential material: do not share it, print it, pass it to the model, or rely on `.gitignore` as protection from other local processes or backups.

The default live model is `deepseek-v4-pro`; set `ADAM_AGENT_MODEL` to override it, for example `deepseek-v4-flash`. Adam sends requests only to `https://api.deepseek.com` in this slice and does not persist credentials, raw provider responses, or reasoning content. Provider failures are reduced to bounded Adam-owned metadata before session persistence. The live model can request the same four tools as the fake path, and write or execute effects still require the existing call-scoped approval.

With `DEEPSEEK_API_KEY` already present, the opt-in live gate runs one answer-only turn, one real read-tool round trip, and two disposable repository lifecycle patches. Each lifecycle case requires exactly one structured `edit_file` mutation and one write approval, uses no shell mutation, and verifies the final files independently:

```bash
ADAM_AGENT_LIVE_TESTS=1 pnpm test:live:deepseek
```

Use `pnpm quality:fix` only when an intentional formatting rewrite is desired. The pre-commit hook is check-only.

See [`AGENTS.md`](AGENTS.md) for the authoritative engineering contract.
