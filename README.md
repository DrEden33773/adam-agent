# Adam Agent

Adam Agent is a lightweight, inspectable TypeScript coding agent for local software-engineering work.

> **Status:** Adam is a Linux-supported source-checkout portfolio checkpoint. The root application and CLI/TUI packages remain private `0.0.0` workspace packages; this is not an npm package, standalone binary, or production release. The separately published `@adam-agent/extension-api` follows its own versioned release lifecycle.

## Quick start

Adam supports Linux with Node.js 24 and pnpm 11. Clone the source, enable the package manager declared by the repository, install the frozen lockfile, and launch the TUI:

```bash
git clone https://github.com/DrEden33773/adam-agent.git
cd adam-agent
corepack enable
pnpm install --frozen-lockfile
pnpm tui
```

The TUI lists durable sessions first and otherwise offers an explicit target picker. For a deterministic local headless check with no provider credential, use an isolated state root:

```bash
ADAM_AGENT_STATE_ROOT="$(mktemp -d)" ADAM_AGENT_TARGET=fake.local pnpm --silent adam "What is this repository?"
```

Run `pnpm tui --help` or `pnpm --silent adam --help` for copyable entry and lifecycle commands. Live Direct DeepSeek setup remains below.

## Evidence

Adam keeps four evidence classes separate so a deterministic fixture is never presented as a live-model or production claim.

| Label | Meaning |
| --- | --- |
| Deterministically tested | Credential-free behavior exercised through public runtime, lifecycle, Presentation, CLI, or TUI seams. |
| Real OS/PTY tested | Linux process, PTY, signal, stdio, terminal-restoration, filesystem, or transport behavior exercised at its irreducible external boundary. |
| Live-provider observed | One bounded credentialed request or workflow observed against an exact named model target; this does not prove general model quality. |
| Human walkthrough observed | One retained end-to-end manual workflow whose Git, test, session, approval, and terminal outcomes were independently checked. |

See [Portfolio acceptance and walkthrough](docs/portfolio-acceptance.md) for the reproducible command matrix, public fixture contract, security boundary, and exact closeout evidence.

## Security model

Adam is intended for trusted local foreground work. Permission decisions, first-party path checks, process lifecycle controls, and code-loading trust are separate controls.

| Surface | Active control | Explicit non-guarantee |
| --- | --- | --- |
| Built-in files | Lexical traversal and symlink escape are rejected beneath the canonical workspace root. | No protection from every hostile same-user race or mount-namespace change. |
| Writes and commands | Write and execute effects require exact call-scoped approval by default. | Approval is not containment and does not make an unreviewed command safe. |
| Shell and MCP | Processes use bounded inputs, environment disclosure, deadlines, process groups, and causal cleanup. | Approved processes retain the invoking user's authority and may use the network; there is no OS, process, or network sandbox. |
| Extensions | Only exact Owner-configured, identity/version-checked packages are activated through bounded Host contracts. | Extensions are trusted in-process JavaScript, not isolated plugins. |
| Credentials and state | Credentials remain external; durable state, artifacts, and configuration use owner-only local paths where specified. | `.env` remains plaintext local input, and local permissions do not defend against every same-user process or backup. |

## Architecture and behavior

The repository contains a provider-neutral Agent kernel with four model-facing coding tools (`read_file`, `write_file`, `edit_file`, and `run_shell`) plus two Agent Skill tools (`activate_skill` and `read_skill_resource`), call-scoped permission requests, canonical event persistence through caller-supplied in-memory and durable project-scoped JSONL stores, cancellation, bounded shell output with durable content-addressed overflow artifacts, and per-run turn/token limits. `write_file` is create-only, while `edit_file` accepts one bounded operations-only patch containing declarative create, exact update, ordinary-text delete, and move operations. Adam binds the normalized patch to one multi-path write approval with a SHA-256 digest, completes all semantic preflight before commit, and uses same-filesystem staging plus compensating rollback for ordinary in-process I/O failures. A rollback failure is reported as `patch_state_uncertain` with affected paths and an opaque reference to owner-only recovery data. A recovery-cleanup failure instead reports whether the workspace is known to be committed or rolled back and tells the caller not to retry automatically; neither result is a crash-safe or cross-path atomic filesystem guarantee.

Every headless CLI run requires an explicit model target. The TUI instead lists existing project sessions first, then resolves an explicit target, a valid saved default, or an exact target picker only after the user chooses New Session. `fake.local` keeps deterministic development available, while the Certified Direct targets `deepseek-v4-flash.direct` and `deepseek-v4-pro.direct` use an exact-pinned Vercel Provider V4 adapter. Adam still owns the Agent loop, tools, permissions, retries, cancellation, deadlines, and canonical state; no SDK Agent or high-level tool loop is used. Filesystem path confinement rejects traversal and symlink escape, while approved shell commands run from the project root with a minimal environment and mandatory timeout/process-group cleanup. Neither mechanism is an OS sandbox or network isolation boundary, and the shell must only be used for trusted local work after reviewing each command. The accepted runtime is Node.js 24 LTS with pnpm 11; Bun is reserved for a later compatibility-tested distribution experiment.

`SessionLifecycle` adds project-scoped create, inspect, hydrate-only resume, explicit cold continuation, and immutable-reference branching. New sessions use strict schema v3 with exact target identity, logical runs, provider attempts, complete response envelopes, tool replay metadata, and public runtime events in one owner-only JSONL; unchanged v1/v2 histories remain inspectable but are deliberately non-resumable. One Linux `flock` owner covers each canonical project for the full mutating lifecycle command, while read-only `inspect` remains available to other processes. Provider deltas stay live-only. A complete bounded response is synchronized before permission handling or tool dispatch; after process death, only an exact `safe` read may run again, while started write, patch, shell, unknown, incomplete, or mismatched work settles as indeterminate rather than being replayed. This is crash-safe canonical replay, not mid-token provider continuation, exactly-once effects, a database, or multi-runtime coordination.

Prompt profile v1 established the B6 repository-instruction contract: one code-owned system base, an exact ordered model-visible Tool Profile, and repository-instruction revision 1. Adam eagerly selects `AGENTS.override.md` before `AGENTS.md` at the canonical project root, treats the selected bytes as bounded untrusted `user` context rather than authorization, and lazily activates descendant scopes only through normalized `read_file`, `write_file`, and `edit_file` paths. A first descendant read persists the new revision before continuing; a first descendant mutation returns `repository_context_changed` under historical profile v1 or `project_context_changed` under current profile v2 before permission or effect so the model must reconsider with a new call ID. Resume, compaction, and prefix branching reuse the persisted revision without rereading disk. The public lifecycle can explicitly reload already-active repository scopes only while the compatible session is idle; the TUI exposes that exact state and command through `/instructions` and `/instructions reload`. There is no headless CLI reload command, parent-directory discovery, shell-text path inference, import syntax, or user-global instruction source. Pre-B6 schema-v3 sessions retain historical prompt profile v0, B6 sessions retain profile v1, and neither is silently upgraded.

Prompt profile v2 adds strict Agent Skills progressive disclosure without upgrading historical sessions. Adam eagerly discovers bounded project `.agents/skills/` and user `~/.agents/skills/` roots, activates descendant project roots only through the same typed path preflight as repository instructions, and can admit fixed `skills/` roots only from already configured, enabled, identity-validated Extension Hosts. Strict maintained-YAML parsing accepts a portable ASCII `name` and `description` subset, quarantines malformed packages, reports ignored `allowed-tools`, and gives every coexisting candidate a stable qualified identity instead of applying silent same-name precedence. The complete immutable Registry is durable, while a deterministic catalog projection uses at most two percent of the frozen context window, capped at 10,000 estimated tokens, shortening descriptions fairly and then omitting whole entries when necessary. The model may activate only a visible exact qualified ID; structured user input and repeatable CLI `--skill` may also select an omitted candidate or a unique short name. Successful activation persists the exact complete `SKILL.md` artifact and a metadata-only bounded resource manifest before making the untrusted content visible. `read_skill_resource` then returns strict UTF-8 pages with identity and quota checks; binary files remain metadata only. Skill text, `allowed-tools`, scripts, user scope, and extension trust never grant a tool or bypass ordinary permissions. Scripts remain mutable live resources executable only through `run_shell`, and clean-idle `SessionLifecycle.reloadSkills()` is the only refresh path. Catalogs, activations, resource provenance, revocations, compaction, restart, and prefix branches replay exact persisted truth rather than silently rereading sources.

Prompt profile v3 adds a trusted local MCP tools path without upgrading historical sessions or bypassing Adam's ordinary tool permissions. New sessions inspect only the canonical project-root `.mcp.json`; `SessionLifecycle.configureMcp()` requires separate workspace confirmation, exact server-definition approval, bounded stdio discovery, explicit per-tool effect classification, and one immutable Tool Profile commit before any MCP definition becomes model-visible. The TUI `/mcp` wizard presents those authorities as separate steps and resumes from the first unresolved authoritative state; it has no combined trust action. B8 accepts preinstalled executables and the exact compatibility grammar `npx -y <package@exact-version> [args...]`, which Adam rewrites into an isolated, script-disabled, integrity-checked package bootstrap before a no-shell launch. Remote transports, credentials, resources, prompts, images, audio, and mutable hot publication remain unsupported and inert. Raw arguments and structured output are schema-validated, large text results spill through the existing Artifact Store, ambiguous dispatched effects are never automatically retried, and cold resume or branching must rediscover an exact Profile match. Approved MCP servers still run as same-user processes: bounded environment disclosure, process groups, deadlines, and causal cleanup are lifecycle controls, not an OS sandbox. The headless CLI exposes no MCP configuration workflow.

Each exact model target also supplies an immutable versioned context profile. Every ordinary or compaction request carries an explicit call-specific output ceiling; ordinary capacity can be clamped against the projected input and a safety reserve, while compaction keeps its own smaller summary ceiling and `maxTokens` remains an aggregate logical-run budget. New Direct DeepSeek sessions use profile v2: a 1,000,000-token context, 384,000-token advertised output capability, 4,096-token request reserve, automatic compaction at 900,000 tokens, and a separate 32,768-token summary ceiling. During a durable run, Adam combines provider-reported input usage with a deterministic local estimate for newly appended messages, automatically compacts before the configured boundary, and can recover once from a provider context-length rejection that occurs before output or tool intent. Compaction uses the same exact target with no tools, preserves deterministic permission, effect, modified-file, artifact, and failure evidence, and synchronizes a validated checkpoint before changing the active projection or making another ordinary model call. Ordinary and compaction usage remain separately visible; known compaction input and output count toward `maxTokens`, missing compaction usage fails closed when that limit is active, and compaction calls never consume `maxTurns`. Historical continuation resolves exact v1 target identity and its 32,768-token policy rather than silently adopting v2. A crash after durable start is recorded as an unknown interrupted attempt on mutating resume, while a synchronized checkpoint is reused without rerunning completed effects. There is no manual compact command, model-callable compact tool, separate summarizer target, provider-owned canonical history, storage rewrite, or pricing claim.

Normalized text plus reasoning share a 64 MiB response envelope, while tool arguments retain independent smaller limits. Response fields above 256 KiB, or every non-empty response field when the encoded canonical record would exceed 1 MiB, are stored in owner-only content-addressed artifacts before bounded references enter the Session log. Replay-reachable response references are limited to 512 MiB of logical bytes per lineage, Session JSONL remains limited to 1 MiB per record and 32 MiB per physical file, and missing or corrupt response artifacts leave bounded degraded inspection metadata while blocking continuation and branching. Provider attempts use a 120-second first-response/inactivity deadline that resets only on accepted non-empty output or valid tool-state progress. A provider `length` finish durably preserves the received answer as `incomplete/output_limit`, makes no automatic continuation request, and executes no tool call from that incomplete response.

The repository also contains the independently packable `@adam-agent/extension-api` contract and a trusted in-process Extension Host foundation. The source contract is `0.3.0`; a release is supported only after its exact main tag, staged OIDC publication, Owner approval and independent registry verification, so source version alone is never registry evidence. Earlier version `0.0.0-bootstrap.0` established the npm package identity and is deprecated; do not depend on it. The Host loads only explicitly configured package roots, validates locked identity, version, compatibility, capability grants and confined ESM entry points before activation, publishes contribution registrations transactionally, and persists enable or disable state before changing visibility. Optional pure-data command, `project_changes@1` input-source and report metadata is collision checked before runtime import. The private project-change admission path captures one bounded Git snapshot through an isolated temporary index and object database, preserves a bounded stable copy of the effective global excludes file, pins diff attributes to the captured candidate inside isolated Git metadata, blocks configured external filters, filesystem monitors and repository hooks, validates the result through the registered exact `adam.project-change-snapshot@1` codec, persists linked v3 truth and only then executes the extension under the same project-lifecycle lease. Its project-scoped operation controller generates operation IDs and owns bounded input decoding, digest-scoped idempotency, deadlines, progress budgets, query, durable-replay-then-live events, cancellation, explicit recovery, and exactly one terminal result. Valid encoded domain rejection remains a completed operation; Host, deadline, capability, persistence, invalid-output, capture and handler failures remain distinct infrastructure truth.

In-memory and owner-only append-only JSONL `OperationStore` Adapters write strict v2 records for ordinary starts and strict v3 records for explicitly linked starts while retaining strict v1 and v2 reads, per-operation sequence and reconciliation-attempt validation, file synchronization before publication, and fail-closed reopen behavior. `OperationHost.startLinked()` requires its configured origin authority to validate the same-project durable command boundary, then persists the exact Host-private session ID, durable source sequence, and `review@1` presentation-command identity before extension execution; exact origin, definition, and canonical input participate in idempotency, and bounded `listLinked()` pagination returns only v3 references inside the requested session prefix. Older records expose no guessed origin and never enter that linked list. The JSONL Adapter rejects a project log above 256 MiB rather than reading an unbounded state file. The default deadline is 60 seconds, configurable by the Host up to five minutes, while an individual start may only tighten it. Inputs are limited to 12,000,000 encoded bytes, outputs to 5,000,000 bytes, JSON to depth 64 and 100,000 containers, and progress to 64 KiB per record, 256 records, and 1 MiB aggregate. Disabling an extension persists and blocks new work before signalling its active operations; a handler that misses the bounded grace period is reported as `disabled_with_pending_operations` without inventing a terminal result. Explicit recovery writes a numbered attempt before calling one exact `0.3.0` read-only reconciliation hook, revalidates immutable record and artifact evidence, and accepts only completed, failed, or stable `inspection_required` truth. It never reruns `execute`, resumes JavaScript, or grants ordinary operation capabilities. Ambiguous terminal persistence is reread before reporting, and a legacy nonterminal record without the exact definition digest becomes stable inspection-required rather than guessed into recovery.

Three concrete operation capabilities are available only when declared, compatible, granted, and backed by their Host broker. `adam.artifact.publish@1` makes content-addressed bytes durable before returning a path-free summary, retains already-published summaries on any later terminal result, and limits an operation to eight artifacts, 8 MiB each and 16 MiB aggregate. `adam.storage.records@1` confines create-if-absent JSON records to a hashed canonical project and exact extension identity, provides get and bounded prefix pagination, and exposes no update, delete, transaction, or storage path. Records are limited to 6 MB each, sixteen creates and 8 MB aggregate per operation, and 256 MB per namespace. `adam.analyzer-execution.biome@1` accepts only UTF-8 file snapshots and the fixed `adam-biome-recommended-v1` profile; each process effect must also receive `allow` from the configured `PermissionPolicy`, while `ask`, `deny`, and policy failure all fail closed before execution. Its pinned Biome process runs in an isolated temporary tree with bounded files, report and diagnostic streams, deadline and cancellation propagation, and process-group cleanup. It accepts no executable, command, arguments, environment, or workspace path, and it does not turn Adam into a review engine.

Extension JavaScript runs with the Adam process's authority: this is not a package installer, marketplace, or security sandbox. Configured package roots are trusted mutable code; the Host validates their call-time state but does not snapshot them or contain concurrent same-user mutation. One Linux `flock` owner prevents another process from starting or reconciling extension effects for the same canonical project; abrupt owner death permits a later numbered recovery attempt. Duplicate recovery calls inside one Host share the same in-flight reconciliation. The normal headless prompt/resume/branch CLI paths do not load extensions; only explicit `--recover-operation` reads the separate owner-only XDG extension configuration. The TUI reads that same optional configuration at startup, activates only validated packages, and derives any contributed slash command from active pure-data descriptors. The extension API package follows a separate npm release lifecycle.

## Development

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm hooks:install
pnpm quality:check
ADAM_AGENT_TARGET=fake.local pnpm --silent adam "What is this repository?"
pnpm tui --target fake.local
```

For the headless CLI, the explicit `fake.local` target exercises deterministic read, edit, and shell scenarios. Omitting a target fails with copy-pastable guidance, and a credential never selects a target implicitly. Adam asks on stderr before write or execute effects. Session and operation JSONL, overflow and extension artifacts, immutable extension records, extension lifecycle state, and private patch recovery data are written under `ADAM_AGENT_STATE_ROOT` when set, otherwise under `~/.local/state/adam-agent`. Recovery data is normally removed after a successful patch or complete rollback. If removal fails, Adam returns `patch_recovery_cleanup_failed` with the known `committed` or `rolled_back` settlement and an opaque reference to the cleanup attempt; because recursive removal may have partially completed, any remaining bundle is not guaranteed to be complete. Inspect the reference and workspace state before any retry. Recovery data is retained intact when Adam stops cleanup because it cannot confirm the workspace state, and this first version deliberately provides no automatic restart recovery.

The TUI stores only `{ "schemaVersion": 1, "defaultTargetId": "<exact-id>" }` in the owner-only user-scoped `$XDG_CONFIG_HOME/adam-agent/config.json`, or the corresponding `~/.config` fallback. Selecting a target for one session and saving it as the default are separate actions; credentials remain external. Malformed, oversized, symlinked, non-ordinary, unknown-target, or unsafe configuration is diagnosed and falls back to explicit selection without changing an existing session's recorded target.

Inside an active TUI session, `/help [topic]` opens categorized local Help and `/hotkeys` opens its read-only fixed effective keymap; `?` remains ordinary editor input. One renderer-local Registry drives exact slash parsing, fuzzy command suggestions, run-state availability, Help, Hotkeys, and the global Ctrl+C/Ctrl+Q dispatch facts, while malformed or unknown slash input is rejected locally and never sent to the model. `/name <text>`, `/name --clear`, and `/name --generate` use canonical naming commands; `/history` consumes the current opaque history cursor; `/fork` branches from the latest visible complete authoritative boundary and `/branch` remains its compatibility alias; `/skills` selects exact qualified IDs for the next admitted turn and `/skills reload` invokes the clean-idle lifecycle refresh. An active compatible `project_changes@1` contribution may add one descriptor-owned no-argument command such as `/review`; Adam captures and persists the bounded Git snapshot before extension execution, then renders only a generic inline operation card with bounded provenance, progress, terminal truth, artifact references, and status-appropriate Ctrl+C cancellation or Ctrl+R recovery. Completed reports open through the existing `/artifacts` navigator, without an extension-specific page, schema parser, renderer, model call, remote discovery, or automatic package activation. Slash, Help-topic, and exact qualified-Skill arguments autocomplete from the Registry or authoritative catalog; Tab completes bounded authoritative project paths without reading file bytes. Up/Down prompt history is reconstructed from at most 100 active-chronology user messages, omits local commands, deduplicates consecutive prompts, and restores the exact unsent draft when returning past the newest item. Typing `@` only at a token boundary opens the bounded fuzzy project-path selector and inserts a normalized backticked project-relative path into the draft without reading bytes or creating an attachment. These renderer actions do not grant tools, permissions, workspace trust, model authority, MCP authority, or an OS sandbox.

`/thinking` opens the exact-target thinking-level selector and `/thinking <level>` selects only a level the active target advertises for the next admitted prompt; the Direct DeepSeek targets expose `off`, `low`, `high`, and `max`, with provider `high` as their mutable default. A selection made during a run applies to the following prompt, unsupported levels fail before provider dispatch, and each admitted prompt durably records its requested and effective policy. Provider-returned reasoning is owner-only and separate from assistant answers: its fold is collapsed by default, Ctrl+T toggles the active block or otherwise the latest visible block, completion preserves an in-process expansion, and reopening a session collapses it again. Inline and artifact-backed reasoning share the same disclosure, while completed, interrupted, and failed blocks retain distinct text markers without depending on color. `/copy` copies only the assistant answer, and the TUI deliberately leaves terminal mouse selection uncaptured because the fixed MainScreen renderer has no reliable application-level mouse hit-testing contract.

Given a known session ID, lifecycle entry is explicit. Hydrate-only resume prints one JSON snapshot and performs no provider or tool work; `--continue` is required to resume an interrupted logical run. Branching writes a new child genesis that references a validated complete parent prefix and never copies or edits parent history:

```bash
pnpm --silent adam --resume <session-id>
pnpm --silent adam --resume <session-id> --continue
pnpm --silent adam --branch <parent-session-id> --at <event-position>
pnpm --silent adam --branch <parent-session-id> --at <event-position> --target deepseek-v4-pro.direct
pnpm --silent adam --skill skill:v1:project:.:release-check "Run the release checks"
```

TUI extension activation and headless operation recovery require an explicit current Owner trust configuration at `$XDG_CONFIG_HOME/adam-agent/extensions.json`, or the corresponding `~/.config` fallback. The TUI treats an absent directory or file as no configured extensions. An existing malformed or unsafe configuration fails visibly; a configured package root that has disappeared disables all new extension commands with a visible diagnostic while the TUI keeps generic historical operations and artifacts reachable. The strict version-1 file contains exact enabled extension identity, version, canonical absolute package root, grants, and bounded activation configuration. Both the `adam-agent` directory and file must be owner-only ordinary paths; symlinks, unknown fields, oversized data, duplicate identities or grants, relative or non-canonical package roots, project `.env` input, repository configuration, operation-log package paths, and remote package discovery all fail closed. A minimal shape is:

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

After restricting the directory to mode `700` and the file to mode `600`, start the TUI to expose commands from active compatible descriptors, or recover one known operation explicitly in the headless CLI:

```bash
pnpm tui
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

The example selects `deepseek-v4-flash.direct`; `deepseek-v4-pro.direct` is the other Certified target. Both use the dedicated `@ai-sdk/deepseek@3.0.28` implementation over the public `@ai-sdk/provider@4.0.7` `LanguageModelV4.doStream()` contract and send requests directly to `https://api.deepseek.com`. The temporary `ADAM_AGENT_PROVIDER=deepseek` plus exact `ADAM_AGENT_MODEL` aliases remain available for migration, but they reject every model other than `deepseek-v4-flash` and `deepseek-v4-pro` and cannot be combined with `ADAM_AGENT_TARGET`. Adam does not persist credentials or raw provider responses. Schema v3 stores only bounded normalized replay-critical reasoning with the complete response envelope in owner-only session state; Adam-owned reasoning start and settlement events are canonical, cumulative text updates are live-only, and the browser-safe Presentation projection preserves explicit owner-only disclosure instead of merging reasoning into an assistant answer. Provider failures are reduced to bounded Adam-owned metadata before session persistence. The live model can request the same six tools as the fake path, and Skill reads, write effects, or execute effects still require the existing call-scoped approval.

`ModelTargets` also exposes `poolside-laguna-s-2.1-free.gateway` through exact-pinned `@ai-sdk/gateway@4.0.52`. It is explicitly Experimental and non-certifying, requires `allowExperimental: true` plus `AI_GATEWAY_API_KEY`, and fixes the request-scoped upstream allowlist to `poolside` without request fallbacks. It is not enabled by the CLI. Hosted team routing rules, service retries, account access, billing, resolved identity, and attempt counts cannot be certified by deterministic code alone, so no production multi-vendor or live Gateway claim is made.

With `DEEPSEEK_API_KEY` already present, the opt-in live gate runs answer-only checks through both unified exact targets, the Direct baseline's answer and real read-tool checks, and two disposable repository lifecycle patches. Each lifecycle case requires exactly one structured `edit_file` mutation and one write approval, uses no shell mutation, and verifies the final files independently. The command never selects or calls Gateway:

```bash
ADAM_AGENT_LIVE_TESTS=1 pnpm test:live:deepseek
```

The synthetic approximately 46.875 MiB model-response durability path is intentionally excluded from ordinary CI because restart, inspection, replay, and branching materialize the response several times. Run it explicitly on a machine with sufficient temporary disk and memory:

```bash
pnpm test:large-output
```

## Test topology

TUI semantic behavior runs in-process through real Presentation, real `runTui`, and a harness-owned `VirtualTerminal`; `apps/tui/src/main.os.test.ts` retains only distinct Linux process, MCP stdio, PTY, signal, resize, paste, and terminal-restoration contracts. Both layers remain part of the single required `pnpm quality:check` regression gate with no changed-path skip; the split changes fixture ownership, not coverage authority. Run them separately while diagnosing with:

```bash
pnpm test:tui:behavior
pnpm test:tui:os
```

Tests synchronize success on rendered output, lifecycle events, filesystem notification, and process closure. Direct timeouts live only in centralized failure or cleanup guards, and test duration is diagnostic telemetry rather than a correctness threshold.

Use `pnpm quality:fix` only when an intentional formatting rewrite is desired. The pre-commit hook is check-only.

See [`AGENTS.md`](AGENTS.md) for the authoritative engineering contract.
