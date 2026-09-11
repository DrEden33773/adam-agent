# Setup, configuration and development

Run development commands from a source checkout. Installed application users can use `adam` for the TUI and `adam-cli` for headless commands; see [local installation](local-installation.md).

## Development commands

The [managed agents guide](managed-control-candidate.md) documents roles, direct input, grants, capacity, navigation and recovery in the ordinary product composition.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm hooks:install
pnpm quality:check
ADAM_AGENT_TARGET=fake.local pnpm --silent adam "What is this repository?"
pnpm tui --target deepseek-v4-flash.direct
```

For the headless CLI, the explicit `fake.local` target exercises deterministic read, edit, and shell scenarios. Omitting a target fails with copy-pastable guidance, and a credential never selects a target implicitly. Adam asks on stderr before write or execute effects. Session and operation JSONL, overflow and extension artifacts, immutable extension records, extension lifecycle state, and private patch recovery data are written under `ADAM_AGENT_STATE_ROOT` when set, otherwise under `~/.local/state/adam-agent`. Recovery data is normally removed after a successful patch or complete rollback. If removal fails, Adam returns `patch_recovery_cleanup_failed` with the known `committed` or `rolled_back` settlement and an opaque reference to the cleanup attempt; because recursive removal may have partially completed, any remaining bundle is not guaranteed to be complete. Inspect the reference and workspace state before any retry. Recovery data is retained intact when Adam stops cleanup because it cannot confirm the workspace state, and this first version deliberately provides no automatic restart recovery.

## User configuration

The TUI stores a strict schema-v2 default target and nullable context, output, and automatic-compaction limits in the owner-only user-scoped `$XDG_CONFIG_HOME/adam-agent/config.json`, or the corresponding `~/.config` fallback. `/config` inspects those values and `/config context|output|compaction <tokens|default>` changes only later new-session policy; every non-default value can only tighten the exact target's official limits, while existing sessions and same-target branches retain their recorded profile. Selecting a target for one session and saving it as the default remain separate actions, and credentials remain external. Malformed, oversized, symlinked, non-ordinary, unknown-target, incompatible, or unsafe configuration fails closed without changing an existing session's recorded target.

### Web tools

Web configuration is stored separately in owner-only `$XDG_CONFIG_HOME/adam-agent/web.json`. `/config` shows its status and `/config web <endpoint>` performs only the fixed `adam-agent-connection-test` SearXNG JSON query before atomically enabling search for later new sessions; `/config web clear` removes only the provider. `/config web-fake-ip <cidr>` explicitly admits one normalized IPv4 subnet inside `198.18.0.0/15` for HTTPS hostname DNS answers only, and `/config web-fake-ip clear` restores strict public-address admission; use it only with an intentionally configured Owner-trusted TUN/fake-IP proxy. Provider and synthetic-DNS settings are preserved independently. A public operator receives the query and network address, and an exact loopback service remains Owner-managed. Missing or null means unconfigured; passive reads plus failed or cancelled candidates fail closed without changing malformed, oversized, duplicate-key, unsafe, manually edited activation-digest, or invalid-range bytes. An explicit Owner clear or valid replacement may overwrite such bytes to repair or revoke the configuration. The file stores no credential, header, proxy, query, result, timestamp, instance list, or standing Web permission, and no live test runs automatically.

## Project trust

Workspace trust is a separate owner-local decision stored as canonical project identity digests in `workspace-trust.json`. When the production TUI opens an untrusted project, its first interactive page requires an explicit decision before session or target selection and before editable input: No is the fail-closed default and exits, Yes persists trust and continues only after the authoritative trusted snapshot is observed, and unavailable or failed mutation remains blocked. `/trust status|grant|revoke` inspects or changes that exact-project decision while idle; revocation restores the startup gate. Trust permits new mutable repository instructions, project Skills, and project MCP configuration to be considered; it does not approve an MCP server or call, extension, model target, tool, shell command, write, credential, permission, or operating-system sandbox. Historical persisted context remains inspectable after revocation, while later project reload, MCP activation, and MCP dispatch stay blocked until the same canonical project is trusted again.

## Commands and navigation

Inside the TUI, `/help [topic]` opens categorized local Help and `/hotkeys` opens its read-only fixed effective keymap; `?` remains ordinary editor input. `/plan` selects or clears process-local Plan intent in an unadmitted new-session draft and enters or exits the authoritative durable Plan cycle for an existing compatible session; `/todos` opens the authoritative read-only Todo browser only after session admission. Parameterless `/exit` clears its literal input and enters the same authoritative cleanup path as Ctrl+Q without submitting the command to the model or persisting it as a draft. One renderer-local Registry drives exact slash parsing, fuzzy command suggestions, run-state availability, Help, Hotkeys, and the global Ctrl+C/Ctrl+Q dispatch facts, while malformed or unknown slash input is rejected locally and never sent to the model. `/attach <path>` stages one immutable local file for the next prompt, while `/detach <index>` and `/cancelattach <index>` remove or cancel a visible draft resource; staging grants no model, tool, or effect authority. `/connection` explicitly starts the selected exact target's authenticated, deadline-bounded `GET /models` test or cancels it while Testing. The process-local display keeps Configured, Reachable, and Certified separate, timestamps completed reachability, persists neither result nor credential, performs no startup probe, retry, fallback, generation, or quota claim, and never changes target selection. `/name <text>`, `/name --clear`, and `/name --generate` use canonical naming commands; `/history` consumes the current opaque history cursor and focuses the oldest newly loaded user turn; `/tree` browses visible complete boundaries in the current session and Enter focuses the corresponding user turn without changing session or chronology truth; `/fork` branches from the latest visible complete authoritative boundary and `/branch` remains its compatibility alias; `/skills` selects exact qualified IDs for the next admitted turn and `/skills reload` invokes the clean-idle lifecycle refresh. An active compatible `project_changes@1` contribution may add one descriptor-owned no-argument command such as `/review`; Adam captures and persists the bounded Git snapshot before extension execution, then renders a generic inline operation card with bounded provenance, progress, terminal truth and artifacts. A persistent Operation/Review row retains current activity when the card scrolls away, with status-appropriate Ctrl+C cancellation or Ctrl+R recovery. Completed reports open through the existing `/artifacts` navigator, without an extension-specific page, schema parser, renderer, model call, remote discovery, or automatic package activation. Slash commands and Help topics use keyword-colored labels while applying plain exact input values; Registry-owned arguments include Help topics, agent views, session settings, draft copying, resource indexes, current-target thinking levels, naming flags, instruction/Skill reload, configuration fields/default, and trust actions. Free-text names, numeric values, paths, searches, Skill identities, and opaque IDs remain direct input, while Tab completes bounded authoritative project paths without reading file bytes. Up/Down prompt history is reconstructed from at most 100 active-chronology user messages, omits local commands, deduplicates consecutive prompts, and restores the exact unsent draft when returning past the newest item. Typing `@` only at a token boundary opens the inline bounded fuzzy project-path completion; accepting a row creates one durable Yellow `@path` atom that copies and submits as text without reading bytes or creating an attachment. Each candidate keeps the full path as its accepted identity while showing the filename in the primary column and its type and path in the description; narrow menus retain selected details. These renderer actions do not grant tools, permissions, workspace trust, model authority, MCP authority, or an OS sandbox.

## Thinking and reading

`/thinking` opens the exact-target thinking-level selector and `/thinking <level>` selects only a level the active target advertises for the next admitted prompt; the Direct DeepSeek targets expose `off`, `low`, `high`, and `max`, with provider `high` as their mutable default. A selection made during a run applies to the following prompt, unsupported levels fail before provider dispatch, and each admitted prompt durably records its requested and effective policy. Provider-returned reasoning is owner-only and separate from assistant answers: its fold is collapsed by default, Ctrl+T toggles the active block or otherwise the block covering the viewport center, then the nearest visible block, then the newest block; completion preserves in-process expansion, and reopening a session collapses every block again. Normal reasoning remains complete inline Markdown; a block above 256 KiB switches atomically to a labelled, sanitized plain-text view backed by at most 16 KiB artifact ranges and one 128 KiB global byte-counted LRU, with explicit above/below loading and local retry feedback. Inline and artifact-backed reasoning share the same disclosure, while completed, interrupted, and failed blocks retain distinct text markers without depending on color, and fold/range/viewport state never enters Session JSONL. Inline tool and reasoning shortcut hints use regular Text without inheriting the adjacent title or status color. The production TUI uses one AltScreen layout with a fixed header/editor/footer and one application-owned scrollable transcript; stable item, wrapped-line, and screen-row coordinates preserve reasoning, tool, operation, history, and chronology positions across rebuilds and resize, while ordinary upward navigation suspends follow-tail and reaching the bottom resumes it. Mouse wheel scrolling, the transient scrollbar, and current-screen text selection that stays highlighted until Ctrl+C performs one bounded clipboard copy are enabled by default; `pnpm tui --no-mouse` disables application mouse capture without removing keyboard navigation. `/copy` continues to copy only the assistant answer, and link activation plus right-click paste remain disabled.

## Headless lifecycle

Given a known session ID, lifecycle entry is explicit. Hydrate-only resume prints one JSON snapshot and performs no provider or tool work; `--continue` is required to resume an interrupted logical run. Branching writes a new child genesis that references a validated complete parent prefix and never copies or edits parent history:

```bash
pnpm --silent adam --resume <session-id>
pnpm --silent adam --resume <session-id> --continue
pnpm --silent adam --branch <parent-session-id> --at <event-position>
pnpm --silent adam --branch <parent-session-id> --at <event-position> --target deepseek-v4-pro.direct
pnpm --silent adam --skill skill:v1:project:.:release-check "Run the release checks"
```

## Extensions

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

## Model credentials

From a source checkout, copy the tracked placeholder file, restrict its permissions, and add the DeepSeek credential to the ignored project-root `.env`:

```bash
cp .env.example .env
chmod 600 .env
# Edit .env and set DEEPSEEK_API_KEY, then run:
pnpm --silent adam "Summarize this repository"
```

Adam loads only `.env` from the current project root. The Adam source checkout ignores that file; in another project, add it to that project's ignore rules. `.env.example` contains names and non-secret defaults only. Values already present in the process environment take precedence, so CI or a shell export can override the local file. The file is still plaintext local credential material: do not share it, print it, pass it to the model, or rely on `.gitignore` as protection from other local processes or backups.

The example selects `deepseek-v4-flash.direct`; `deepseek-v4-pro.direct` is the other Certified text target, and `deepseek-v4-flash-vision-exp.direct` is the separately labelled non-default current Vision Responses target. Text targets and historical Vision Chat profile v1 use the dedicated `@ai-sdk/deepseek@3.0.30` implementation over the public `@ai-sdk/provider@4.0.7` `LanguageModelV4.doStream()` contract; current Vision profile v2 uses Adam's bounded Direct Responses SSE driver, and both routes send requests directly to `https://api.deepseek.com`. The `ADAM_AGENT_PROVIDER=deepseek` plus exact `ADAM_AGENT_MODEL` aliases remain available for existing configurations, but they reject every model other than `deepseek-v4-flash`, `deepseek-v4-pro`, and `deepseek-v4-flash-vision-exp` and cannot be combined with `ADAM_AGENT_TARGET`. Adam does not persist credentials, provider response IDs, provider conversation state, or raw provider responses. Schema v3 stores only bounded normalized replay-critical reasoning with the complete response envelope in owner-only session state; Adam-owned reasoning start and settlement events are canonical, cumulative text updates are live-only, and the browser-safe Presentation projection preserves explicit owner-only disclosure instead of merging reasoning into an assistant answer. Provider failures are reduced to bounded Adam-owned metadata before session persistence. The live model uses the same recorded tool permissions. New sessions allow exact built-in Todo bookkeeping by default; filesystem writes, execution and delegation retain their own permission requirements. Historical sessions retain their recorded policy until explicitly upgraded.

### Experimental targets

`ModelTargets` also exposes `poolside-laguna-s-2.1-free.gateway` through exact-pinned `@ai-sdk/gateway@4.0.52`. It is explicitly Experimental and non-certifying, requires `allowExperimental: true` plus `AI_GATEWAY_API_KEY`, and fixes the request-scoped upstream allowlist to `poolside` without request fallbacks. It is not enabled by the CLI. Hosted team routing rules, service retries, account access, billing, resolved identity, and attempt counts cannot be certified by deterministic code alone, so no production multi-vendor or live Gateway claim is made.

## Opt-in provider checks

With `DEEPSEEK_API_KEY` already present, the full opt-in live gate runs answer-only checks through both text targets, the Direct baseline's answer and real read-tool checks, one generated local PNG through historical eager Vision Chat v1, the same image-dependent quadrant assertion through current lazy Vision Responses v2, and two disposable repository lifecycle patches. The Vision cases check only bounded durable target/resource/projection facts before deleting their temporary images and session state. Each patch case requires exactly one structured `edit_file` mutation and one write approval, uses no shell mutation, and verifies the final files independently. Neither command selects or calls Gateway:

```bash
ADAM_AGENT_LIVE_TESTS=1 pnpm test:live:deepseek
ADAM_AGENT_LIVE_TESTS=1 pnpm test:live:vision-chat
ADAM_AGENT_LIVE_TESTS=1 pnpm test:live:vision-responses
```

## Large-output durability check

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

See [`AGENTS.md`](../AGENTS.md) for the authoritative engineering contract.
