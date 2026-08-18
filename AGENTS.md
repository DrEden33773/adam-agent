# Engineering Instructions

## Product objective

Build a lightweight, inspectable local coding agent. Make the core coding path reliable and pleasant before expanding automation, orchestration, or presentation features.

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
- Every behavior change and bug fix must include proportionate tests at a pre-agreed caller-visible seam.
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
- Plan Mode uses a runtime allow-list and denies unknown, MCP, network, write, and execute effects unless a narrowly defined read-only adapter is explicitly classified.
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

- Before writing a behavior test, name the public interface and observable result under test. Work one failing behavior test and the minimum implementation to pass it at a time.
- Do not pre-write a horizontal test suite, test private internals, or mock Adam-owned modules. Fake external providers, clocks, processes, filesystems, MCP servers, and Web sources only at their real seams.
- Test through module interfaces and observable runtime events rather than private implementation state.
- Synchronize concurrent and process tests on causal observables such as events, IPC, filesystem notifications, stream output, or child closure. Never use polling intervals, arbitrary sleeps, elapsed-time assertions, or wait-then-assert-absence as success criteria; timeouts are failure and cleanup guards only.
- Test deadline and backoff policy with a fake clock. Use real time only when timer or OS-process integration is itself under test and no causal fake-clock seam exists; block fixtures on events or open streams instead of finite sleeps.
- Use deterministic provider streams for tool ordering, rejection, cancellation, malformed output, compaction, and retry tests.
- Add real-process tests for shell cancellation, MCP lifecycle, path confinement, and signal handling when the corresponding adapters exist.
- Add PTY or real-terminal coverage for resize, bracketed paste, wide-character input, permission prompts, interrupt, and cleanup when the interactive terminal exists.
- Keep live-provider, live-Web, and external MCP tests opt-in; ordinary CI must not require credentials or network access.
- Run focused tests while iterating and the complete Linux check once before merge.
- Use Node.js 24 LTS, ESM, strict TypeScript, and the exact pnpm 11 release declared by `packageManager`. Commit `pnpm-lock.yaml`; do not use npm, Yarn, or Bun lockfiles.
- Use Biome for TypeScript and JavaScript formatting and linting, and markdownlint-cli2 for Markdown. Keep hooks check-only; use explicit `*:fix` commands for intentional rewrites.
- Run `pnpm quality:check` before merge. Keep one Linux quality workflow until product behavior creates a demonstrated need for another job.
- Do not introduce Nx, Turborepo, or another task orchestrator while pnpm workspaces and TypeScript project references are sufficient.
