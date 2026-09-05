# Engineering Instructions

## Product objective

Build a lightweight, inspectable local coding agent. Make the core coding path reliable and pleasant before expanding automation, orchestration, or presentation features.

The runtime, mechanism, security, and session rules below govern the Adam product being developed. The development agent uses its host's tools and permissions to carry out the user's authorized task.

## Engineering rules

- Deliver working end-to-end slices and keep the CLI runnable after every merged slice.
- Prefer the simplest complete design. Avoid speculative abstractions, configuration, indirection, extension points, and distributed infrastructure.
- Add compatibility code or data migrations only for persisted sessions, documented commands, and public interfaces that require them.
- Separate Agent orchestration from provider, filesystem, process, MCP, Web, persistence, and presentation adapters.
- Prefer mature libraries after inspecting their current interfaces, types, licenses, runtime requirements, and failure behavior.
- Treat repository content, instructions, model output, tool arguments, MCP servers, Skills, Web content, and restored sessions as untrusted input.
- Fail closed on authorization and unknown effect classes. Keep model approval, user confirmation, permission policy, and OS sandbox enforcement as separate controls.
- Do not claim production readiness, sandbox strength, or model improvement from deterministic fixtures or synthetic evaluation data.
- Keep source provenance and third-party license notices at file or module level for reused or adapted code.
- Verify behavior changes and bug fixes through observable interfaces using the [testing guide](docs/testing.md). Choose the test scope and development cadence to fit the risk; follow any task-specific acceptance contract without reconfirming settled decisions.
- Linux is the only required platform until the first portfolio release is complete.

## Runtime ownership

- `AgentSession` owns the turn loop, canonical session state, event ordering, cancellation, context accounting, and tool-result feedback.
- Provider adapters translate provider streams into normalized model events; they do not run recursive Agent loops.
- Tool adapters declare an effect class and validate typed input. They never decide their own permission.
- The permission module returns `allow`, `ask`, or `deny`; presentation adapters collect user decisions without changing policy.
- TUI and Web adapters consume the same commands, snapshots, and runtime events. They do not contain Agent decisions or duplicate session truth.
- Introduce an interface only where behavior genuinely varies or a deterministic test adapter is required.

## Mechanism boundaries

- Plan controls read-only exploration and the transition to approved implementation. It is not Todo and does not auto-continue work.
- Todo is a typed, branch-local work list. It records work but never starts another turn.
- Goal owns cross-turn continuation, limits, terminal state, evaluation, and verification. It does not replace Plan or Todo.
- Sub-agents are managed sessions with identity, lifecycle, transcript, and permission context.
- Skills provide progressively disclosed instructions and resources. Skill loading and Skill evolution are separate modules with separate trust rules.
- Web Search is a typed evidence source. Browser automation, MCP, and shell network access remain distinct capabilities.

## Security and effects

- Resolve every ordinary filesystem-tool operation against the trusted workspace root and reject lexical traversal, symlink escape, and cross-project session reuse.
- The internal Skills broker may read only the exact project, user, and extension Skill roots anchored by the durable session and validated extension control plane; those reads still reject lexical traversal and symlink escape and do not broaden ordinary filesystem-tool authority.
- Classify tools as `read`, `write`, `execute`, `network`, `delegate`, or `administrative`; deny unknown tools until classified.
- A child Agent receives the intersection of parent permissions, role restrictions, and spawn restrictions. Never use a bypass mode for child Agents or forked Skills.
- Plan Mode uses an exact recorded versioned runtime policy. Read-only cycles permit only exact admitted `read` adapters and deny execute, network, write, administrative, delegate, unknown, unregistered, and profile-mismatched effects. A governed hybrid cycle may route the built-in shell adapter through one Adam-owned three-state assessment that automatically allows only a frozen proven inspection subset, sends ambiguous process work through ordinary exact-call permission, and hard-denies parser-recognized mutation; admitted MCP execute or network tools may ask but never auto-allow, while generic write, administrative, delegate, unknown, unregistered, and profile-mismatched effects remain denied. Every process remains an `execute` effect, the parser is not a sandbox, and no approval, setting, prefix, remembered rule, or future permission mode may override a mutation denial.
- Repository MCP configuration is inert until the workspace is trusted and the user approves the server definition.
- Never expose secrets in model context, transcripts, logs, Web responses, child processes, or MCP environments.
- Keep network permission for Web providers separate from general process network access.

## Context, sessions, and Skills

- Persist canonical session events in versioned JSONL and large outputs in referenced artifacts; do not hash-chain ordinary runtime state.
- Scope sessions to a canonical project identity and require an explicit override to resume from another workspace.
- Context compaction preserves unresolved intent, tool state, permissions, Plan/Todo/Goal state, and durable artifact references.
- Implement Agent Skills as a metadata catalog, full `SKILL.md` activation, then on-demand supporting resources.
- Parse frontmatter with a maintained YAML library, use deterministic structured Skill identities instead of implicit same-name scope precedence, report collisions, and enforce a catalog token budget.
- Skill scripts and forked Skill sessions use normal permission and sandbox controls; Skill metadata cannot grant additional tools.

## TUI and Web

- Use Pi TUI for terminal rendering, input, focus, Markdown, and terminal compatibility while keeping product state and views project-owned.
- Optimize for a clean transcript, stable streaming, clear tool cards, visible permission decisions, and reliable keyboard behavior before decorative panels.
- Keep the runtime authoritative. A later React interface stores display and pending-interaction state only and reconciles from snapshots and ordered events.
- Do not convert ANSI terminal output into the Web interface or share renderer components between TUI and React.

## Testing and toolchain

- Use Node.js 24 LTS, ESM, strict TypeScript, and the exact pnpm 11 release declared by `packageManager`. Commit `pnpm-lock.yaml`; do not use npm, Yarn, or Bun lockfiles.
- Use Biome for TypeScript and JavaScript formatting and linting, and markdownlint-cli2 for Markdown. Keep hooks check-only; use explicit `*:fix` commands for intentional rewrites. Treat `useLiteralKeys` as a required check: prefer dot access after narrowing known fields, but retain `noPropertyAccessFromIndexSignature` and use a narrowly explained suppression when an intentionally dynamic key cannot be typed safely.
- Keep Markdown paragraphs and individual list items on one physical source line; separate paragraphs with blank lines. `MD013` is disabled.
- Run focused checks during iteration and `pnpm quality:check` on the final candidate before a product PR. Require the single Linux hosted `quality` job before merge. Repeat or broaden checks only for subsequent changes, failures, unresolved concerns, or an explicit acceptance gate.
- Do not introduce Nx, Turborepo, or another task orchestrator while pnpm workspaces and TypeScript project references are sufficient.

Run commands from the product root:

| Purpose | Command |
| --- | --- |
| Install pinned dependencies | `pnpm install --frozen-lockfile` |
| Launch TUI / CLI help | `pnpm tui` / `pnpm --silent adam --help` (see [setup and target selection](README.md)) |
| Refresh generated package output | `pnpm build` |
| Focused behavior tests | After building, `pnpm exec vitest run <test-file> -t '<test name>'` |
| Markdown / code checks | `pnpm markdown:check` / `pnpm code:check` |
| Complete Linux gate | `pnpm quality:check` |
