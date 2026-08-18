# Adam Agent

Adam Agent is a lightweight, inspectable TypeScript coding agent for local software-engineering work.

The repository contains a provider-neutral Agent kernel with four model-facing coding tools (`read_file`, `write_file`, `edit_file`, and `run_shell`), call-scoped permission requests, canonical event persistence through caller-supplied in-memory and durable project-scoped JSONL stores, cancellation, bounded shell output with durable content-addressed overflow artifacts, and per-run turn/token limits. `write_file` is create-only, while `edit_file` accepts one bounded operations-only patch containing declarative create, exact update, ordinary-text delete, and move operations. Adam binds the normalized patch to one multi-path write approval with a SHA-256 digest, completes all semantic preflight before commit, and uses same-filesystem staging plus compensating rollback for ordinary in-process I/O failures. A rollback failure is reported as `patch_state_uncertain` with affected paths and an opaque reference to owner-only recovery data. A recovery-cleanup failure instead reports whether the workspace is known to be committed or rolled back and tells the caller not to retry automatically; neither result is a crash-safe or cross-path atomic filesystem guarantee.

Every CLI run now requires an explicit model target. `fake.local` keeps deterministic development available, while the Certified Direct targets `deepseek-v4-flash.direct` and `deepseek-v4-pro.direct` use an exact-pinned Vercel Provider V4 adapter. Adam still owns the Agent loop, tools, permissions, retries, cancellation, deadlines, and canonical state; no SDK Agent or high-level tool loop is used. Filesystem path confinement rejects traversal and symlink escape, while approved shell commands run from the project root with a minimal environment and mandatory timeout/process-group cleanup. Neither mechanism is an OS sandbox or network isolation boundary, and the shell must only be used for trusted local work after reviewing each command. The accepted runtime is Node.js 24 LTS with pnpm 11; Bun is reserved for a later compatibility-tested distribution experiment.

`SessionLifecycle` adds project-scoped create, inspect, hydrate-only resume, explicit cold continuation, and immutable-reference branching. New sessions use strict schema v3 with exact target identity, logical runs, provider attempts, complete response envelopes, tool replay metadata, and public runtime events in one owner-only JSONL; unchanged v1/v2 histories remain inspectable but are deliberately non-resumable. One Linux `flock` owner covers each canonical project for the full mutating lifecycle command, while read-only `inspect` remains available to other processes. Provider deltas stay live-only. A complete bounded response is synchronized before permission handling or tool dispatch; after process death, only an exact `safe` read may run again, while started write, patch, shell, unknown, incomplete, or mismatched work settles as indeterminate rather than being replayed. This is crash-safe canonical replay, not mid-token provider continuation, exactly-once effects, a database, or multi-runtime coordination.

New schema-v3 sessions also freeze prompt profile v1: one code-owned system base, the exact ordered model-visible Tool Profile, and repository-instruction revision 1. Adam eagerly selects `AGENTS.override.md` before `AGENTS.md` at the canonical project root, treats the selected bytes as bounded untrusted `user` context rather than authorization, and lazily activates descendant scopes only through normalized `read_file`, `write_file`, and `edit_file` paths. A first descendant read persists the new revision before continuing; a first descendant mutation instead returns `repository_context_changed` before permission or effect so the model must reconsider with a new call ID. Resume, compaction, and prefix branching reuse the persisted revision without rereading disk. The public lifecycle can explicitly reload already-active scopes only on an idle v1 session; there is no CLI reload command, parent-directory discovery, shell-text path inference, import syntax, or user-global instruction source. Pre-B6 schema-v3 sessions retain historical prompt profile v0 instead of being silently upgraded.

Each exact model target also supplies an immutable versioned context profile. Every ordinary or compaction request carries an explicit call-specific output ceiling; ordinary capacity can be clamped against the projected input and a safety reserve, while compaction keeps its own smaller summary ceiling and `maxTokens` remains an aggregate logical-run budget. New Direct DeepSeek sessions use profile v2: a 1,000,000-token context, 384,000-token advertised output capability, 4,096-token request reserve, automatic compaction at 900,000 tokens, and a separate 32,768-token summary ceiling. During a durable run, Adam combines provider-reported input usage with a deterministic local estimate for newly appended messages, automatically compacts before the configured boundary, and can recover once from a provider context-length rejection that occurs before output or tool intent. Compaction uses the same exact target with no tools, preserves deterministic permission, effect, modified-file, artifact, and failure evidence, and synchronizes a validated checkpoint before changing the active projection or making another ordinary model call. Ordinary and compaction usage remain separately visible; known compaction input and output count toward `maxTokens`, missing compaction usage fails closed when that limit is active, and compaction calls never consume `maxTurns`. Historical continuation resolves exact v1 target identity and its 32,768-token policy rather than silently adopting v2. A crash after durable start is recorded as an unknown interrupted attempt on mutating resume, while a synchronized checkpoint is reused without rerunning completed effects. There is no manual compact command, model-callable compact tool, separate summarizer target, provider-owned canonical history, storage rewrite, or pricing claim.

Normalized text plus reasoning share a 64 MiB response envelope, while tool arguments retain independent smaller limits. Response fields above 256 KiB, or every non-empty response field when the encoded canonical record would exceed 1 MiB, are stored in owner-only content-addressed artifacts before bounded references enter the Session log. Replay-reachable response references are limited to 512 MiB of logical bytes per lineage, Session JSONL remains limited to 1 MiB per record and 32 MiB per physical file, and missing or corrupt response artifacts leave bounded degraded inspection metadata while blocking continuation and branching. Provider attempts use a 120-second first-response/inactivity deadline that resets only on accepted non-empty output or valid tool-state progress. A provider `length` finish durably preserves the received answer as `incomplete/output_limit`, makes no automatic continuation request, and executes no tool call from that incomplete response.

The repository also contains the independently packable `@adam-agent/extension-api` contract and a trusted in-process Extension Host foundation. The source contract is `0.2.0`; public registry version `0.1.0` remains the current supported consumer release until the separately gated `0.2.0` tag, staged OIDC publication, Owner approval, and verification complete. Earlier version `0.0.0-bootstrap.0` established the npm package identity and is deprecated; do not depend on it. The Host loads only explicitly configured package roots, validates locked identity, version, compatibility, capability grants, and confined ESM entry points before activation, publishes contribution registrations transactionally, and persists enable or disable state before changing visibility. Its project-scoped operation controller generates operation IDs and owns bounded input decoding, digest-scoped idempotency, deadlines, progress budgets, query, durable-replay-then-live events, cancellation, explicit recovery, and exactly one terminal result. Valid encoded domain rejection remains a completed operation; Host, deadline, capability, persistence, invalid-output, and handler failures remain distinct infrastructure truth.

In-memory and owner-only append-only JSONL `OperationStore` Adapters write strict v2 records while retaining strict v1 reads, per-operation sequence and reconciliation-attempt validation, file synchronization before publication, and fail-closed reopen behavior. The JSONL Adapter rejects a project log above 256 MiB rather than reading an unbounded state file. The default deadline is 60 seconds, configurable by the Host up to five minutes, while an individual start may only tighten it. Inputs are limited to 12,000,000 encoded bytes, outputs to 5,000,000 bytes, JSON to depth 64 and 100,000 containers, and progress to 64 KiB per record, 256 records, and 1 MiB aggregate. Disabling an extension persists and blocks new work before signalling its active operations; a handler that misses the bounded grace period is reported as `disabled_with_pending_operations` without inventing a terminal result. Explicit recovery writes a numbered attempt before calling one exact `0.2.0` read-only reconciliation hook, revalidates immutable record and artifact evidence, and accepts only completed, failed, or stable `inspection_required` truth. It never reruns `execute`, resumes JavaScript, or grants ordinary operation capabilities. Ambiguous terminal persistence is reread before reporting, and a legacy nonterminal record without the exact definition digest becomes stable inspection-required rather than guessed into recovery.

Three concrete operation capabilities are available only when declared, compatible, granted, and backed by their Host broker. `adam.artifact.publish@1` makes content-addressed bytes durable before returning a path-free summary, retains already-published summaries on any later terminal result, and limits an operation to eight artifacts, 8 MiB each and 16 MiB aggregate. `adam.storage.records@1` confines create-if-absent JSON records to a hashed canonical project and exact extension identity, provides get and bounded prefix pagination, and exposes no update, delete, transaction, or storage path. Records are limited to 6 MB each, sixteen creates and 8 MB aggregate per operation, and 256 MB per namespace. `adam.analyzer-execution.biome@1` accepts only UTF-8 file snapshots and the fixed `adam-biome-recommended-v1` profile; each process effect must also receive `allow` from the configured `PermissionPolicy`, while `ask`, `deny`, and policy failure all fail closed before execution. Its pinned Biome process runs in an isolated temporary tree with bounded files, report and diagnostic streams, deadline and cancellation propagation, and process-group cleanup. It accepts no executable, command, arguments, environment, or workspace path, and it does not turn Adam into a review engine.

Extension JavaScript runs with the Adam process's authority: this is not a package installer, marketplace, or security sandbox. Configured package roots are trusted mutable code; the Host validates their call-time state but does not snapshot them or contain concurrent same-user mutation. One Linux `flock` owner prevents another process from starting or reconciling extension effects for the same canonical project; abrupt owner death permits a later numbered recovery attempt. Duplicate recovery calls inside one Host share the same in-flight reconciliation. The normal prompt/resume/branch CLI paths do not load extensions; only explicit `--recover-operation` reads the separate owner-only XDG extension configuration. The extension API package follows a separate npm release lifecycle.

## Development

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm hooks:install
pnpm quality:check
ADAM_AGENT_TARGET=fake.local pnpm --silent adam "What is this repository?"
```

The explicit `fake.local` target exercises deterministic read, edit, and shell scenarios. Omitting a target fails with copy-pastable guidance, and a credential never selects a target implicitly. Adam asks on stderr before write or execute effects. Session and operation JSONL, overflow and extension artifacts, immutable extension records, extension lifecycle state, and private patch recovery data are written under `ADAM_AGENT_STATE_ROOT` when set, otherwise under `~/.local/state/adam-agent`. Recovery data is normally removed after a successful patch or complete rollback. If removal fails, Adam returns `patch_recovery_cleanup_failed` with the known `committed` or `rolled_back` settlement and an opaque reference to the cleanup attempt; because recursive removal may have partially completed, any remaining bundle is not guaranteed to be complete. Inspect the reference and workspace state before any retry. Recovery data is retained intact when Adam stops cleanup because it cannot confirm the workspace state, and this first version deliberately provides no automatic restart recovery.

Given a known session ID, lifecycle entry is explicit. Hydrate-only resume prints one JSON snapshot and performs no provider or tool work; `--continue` is required to resume an interrupted logical run. Branching writes a new child genesis that references a validated complete parent prefix and never copies or edits parent history:

```bash
pnpm --silent adam --resume <session-id>
pnpm --silent adam --resume <session-id> --continue
pnpm --silent adam --branch <parent-session-id> --at <event-position>
pnpm --silent adam --branch <parent-session-id> --at <event-position> --target deepseek-v4-pro.direct
```

Operation recovery requires an explicit current Owner trust configuration at `$XDG_CONFIG_HOME/adam-agent/extensions.json`, or the corresponding `~/.config` fallback. The strict version-1 file contains exact enabled extension identity, version, canonical absolute package root, grants, and bounded activation configuration. Both the `adam-agent` directory and file must be owner-only ordinary paths; symlinks, unknown fields, oversized data, duplicate identities or grants, relative or non-canonical package roots, project `.env` input, repository configuration, operation-log package paths, and remote package discovery all fail closed. A minimal shape is:

```json
{
  "schemaVersion": 1,
  "extensions": [
    {
      "enabled": true,
      "extensionId": "example.extension",
      "packageName": "@example/adam-extension",
      "packageVersion": "2.0.0",
      "packageRoot": "/absolute/canonical/path/to/package",
      "grants": [],
      "configuration": null
    }
  ]
}
```

After restricting the directory to mode `700` and the file to mode `600`, recover one known operation explicitly:

```bash
pnpm --silent adam --recover-operation <operation-id>
```

To use the live DeepSeek Adapter locally, copy the tracked placeholder file, restrict its permissions, and add the credential to the ignored project-root `.env`:

```bash
cp .env.example .env
chmod 600 .env
# Edit .env and set DEEPSEEK_API_KEY, then run:
pnpm --silent adam "Summarize this repository"
```

Adam loads only `.env` from the current project root and ignores it through the repository's committed `.gitignore`; `.env.example` contains names and non-secret defaults only. Values already present in the process environment take precedence, so CI or a shell export can override the local file. The file is still plaintext local credential material: do not share it, print it, pass it to the model, or rely on `.gitignore` as protection from other local processes or backups.

The example selects `deepseek-v4-flash.direct`; `deepseek-v4-pro.direct` is the other Certified target. Both use the dedicated `@ai-sdk/deepseek@3.0.28` implementation over the public `@ai-sdk/provider@4.0.7` `LanguageModelV4.doStream()` contract and send requests directly to `https://api.deepseek.com`. The temporary `ADAM_AGENT_PROVIDER=deepseek` plus exact `ADAM_AGENT_MODEL` aliases remain available for migration, but they reject every model other than `deepseek-v4-flash` and `deepseek-v4-pro` and cannot be combined with `ADAM_AGENT_TARGET`. Adam does not persist credentials or raw provider responses. Schema v3 stores only bounded normalized replay-critical reasoning with the complete response envelope in owner-only session state; it is excluded from public runtime events and snapshots. Provider failures are reduced to bounded Adam-owned metadata before session persistence. The live model can request the same four tools as the fake path, and write or execute effects still require the existing call-scoped approval.

`ModelTargets` also exposes `poolside-laguna-s-2.1-free.gateway` through exact-pinned `@ai-sdk/gateway@4.0.52`. It is explicitly Experimental and non-certifying, requires `allowExperimental: true` plus `AI_GATEWAY_API_KEY`, and fixes the request-scoped upstream allowlist to `poolside` without request fallbacks. It is not enabled by the CLI. Hosted team routing rules, service retries, account access, billing, resolved identity, and attempt counts cannot be certified by deterministic code alone, so no production multi-vendor or live Gateway claim is made.

With `DEEPSEEK_API_KEY` already present, the opt-in live gate runs answer-only checks through both unified exact targets, the Direct baseline's answer and real read-tool checks, and two disposable repository lifecycle patches. Each lifecycle case requires exactly one structured `edit_file` mutation and one write approval, uses no shell mutation, and verifies the final files independently. The command never selects or calls Gateway:

```bash
ADAM_AGENT_LIVE_TESTS=1 pnpm test:live:deepseek
```

The synthetic approximately 46.875 MiB model-response durability path is intentionally excluded from ordinary CI because restart, inspection, replay, and branching materialize the response several times. Run it explicitly on a machine with sufficient temporary disk and memory:

```bash
pnpm test:large-output
```

Use `pnpm quality:fix` only when an intentional formatting rewrite is desired. The pre-commit hook is check-only.

See [`AGENTS.md`](AGENTS.md) for the authoritative engineering contract.
