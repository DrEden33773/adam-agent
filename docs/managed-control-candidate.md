# Managed agents

Ordinary TUI and CLI sessions run child threads through `ManagedAgentControl`, the existing `AgentSession` loop, and shared Lifecycle/Presentation owners. The production composition owns one durable Control store and separate child session records.

The same composition provides the public `adam.managed-review@1` contract through OperationHost and the shared reserved Control lane. The Host owns immutable invocation identity, origin resolution, no-tool execution, total deadline, cancellation and settlement. Reviewers expose aggregate lane counts to ordinary Fleet inspection and remain outside Agent handles, controls and Main completion delivery. The [Extension API contract](https://github.com/DrEden33773/adam-agent/blob/main/packages/extension-api/README.md) documents the wire bounds and failure outcomes.

## Roles and authority

Explore receives repository reads, explicitly selected immutable input resources, its own frozen Skill catalog, and bounded parent coordination. Research adds the exact Web tools available to Main. An unconfigured search provider exposes no `web_search`; fetch uses normal network permission, while open/find read immutable evidence without another network request. Children cannot write, execute shell commands, access MCP or ambient extensions, or create other children. Skill content does not grant authority.

Each new thread freezes its role definition, exact certified target, effective context and thinking policy, initial context, permissions and budget. Unconfigured roles inherit Main's effective target and limits. A configured but unavailable target requires an explicit Use inherited, Update, or Cancel choice. Reloading definitions or the parent Skill catalog affects future threads. Existing threads retain their frozen definitions and independently activated Skills.

The current Plan policy, `plan-policy.hybrid-delegation-todo-v1`, admits the registered non-mutating role/control and Main/Research Web families under their ordinary permissions, plus exact built-in session Todo bookkeeping under the recorded Todo permission policy. Historical `plan-policy.hybrid-delegation-v1` retains its original Todo denial. Current Plan and permission ceilings remain enforceable at execution, queued work and recovery boundaries. Compatible work can continue while Plan is active. Plan approval is never delegated to a child.

## Custom definitions

Trusted project definitions live in `.agents/agents/*.md`; user definitions live in `$XDG_CONFIG_HOME/adam-agent/agents/*.md`, with `~/.config` as the fallback configuration root. The Agent types surface supports explicit preview, creation, duplication, built-in ejection, enable/disable and reload. Writes are atomic and revalidate their source authority. Invalid files appear as isolated diagnostics.

```markdown
---
name: audit
description: Inspect repository evidence.
base: explore
tools: [read_file, search_repository, read_input_resource]
skills: false
context_mode: task
---
Cite the exact evidence used for each conclusion.
```

Definitions may use `display_name`, `color`, `model`, `thinking`, `web`, `limits`, and an explicit qualified `overrides` identity. These settings can only narrow a built-in base. Unknown fields, ambiguous names and unqualified overrides do not silently replace another definition. Models cannot select targets through spawn arguments.

## Direct input and grants

Selecting a role from `@` completion creates a semantic role reference. Selecting a handle or lifetime alias creates an exact thread reference; selected `@main` routes to Main. Manually typed or pasted mentions remain literal. References survive atomic cursor movement, deletion, undo, history and recoverable draft storage. Copy exposes visible text only. Multiple recipients require an explicit choice; stale references require removal, literal conversion or a new selection.

A leading selected role opens a delegation review before admission. The same surface supports model-requested delegation through the pending permission owner. It exposes context choice, removable Skill pre-activations, execution mode, optional task budgets and Custom limits, plus the complete grant and policy identities. An empty new-session draft creates its parent Session only after confirmation and validation, without a Main provider turn. Folded pasted text is included in the delegated task and remains subject to the task size limit.

Only explicitly selected input artifacts are linked into the child. Direct attachments use staged immutable bytes; model calls name exact parent occurrence IDs in `entries[].artifacts`. The runtime resolves those IDs through validated parent history, records their source boundary, and binds bounded `read_input_resource` access to the selected child occurrences. New turns preserve prior attachments and may explicitly add more. Attachments cannot be sent as cooperative input into a currently running turn; the draft remains available until a new turn can accept them. Unsupported media remain subject to the receiving target's normal resource capabilities.

Task only, Current request and Selected messages govern initial text sharing. Complete parent history, later messages, configuration changes and other child completions are not automatically copied. Later input uses an exact post, parent-input reply or new-turn receipt. Accepted input, delivered input, settled completion, user-seen state and Main consumption are distinct durable facts.

## Task budgets

New delegation envelopes explicitly use an unbudgeted task policy by default. They do not derive cumulative thread, batch or Session ceilings from a model context window. Choosing a task budget in delegation review creates one immutable grant shared by every member and its continuations, including compaction. The new-turn composer accepts `/budget-add <tokens> <task>` as explicit Owner authorization for an additive grant. It never rewrites the original grant or changes a historical envelope into an unbudgeted one. Current context/output capabilities and explicitly frozen role/reviewer restrictions remain distinct.

Provider reservations bind exact child transcript boundaries. Missing usage retains spending uncertainty; a late receipt settles once, and a missing accounting link requires inspection rather than a refund. A still-affordable closing request has no tools and reports retained evidence and unfinished work. If no request fits, the outcome retains available evidence and explains the budget stop.

## Capacity and navigation

Background `spawn_agents` admits 1–32 entries atomically, with eight running per Main session by default and overflow queued. Additional batches may exceed the old queue-count boundary; ordinary history and turn identities have no lifetime count ceiling. Explicit task grants, role constraints and durable storage capacity remain enforced. Foreground accepts one entry and shares one reserved running slot with review; four further reserved requests may wait. Waiting permissions release running capacity, and an accepted decision must reacquire a slot before the next effect proceeds.

The startup card shows the admitted identity and `Ctrl+O` expands its tool details. Persistent Agent activity summarizes running, waiting, queued and finished work, with hidden counts under compression. `/agents` opens the workspace; `d` opens exact details and Enter opens a full conversation page in the central area. Children open in browsing mode, including when they have a retained draft. A fresh Enter opens the independent composer; Enter there sends to the displayed exact thread and turn. Escape preserves the draft and returns to browsing, then to the originating navigation view. Main keeps its own draft and reading position. Child reading position and Markdown mode survive return visits to the same turn. Mouse wheel, paging keys and Home/End act on the focused conversation. From an empty Main composer, Down enters Fleet navigation; merely selecting a row does not change the input recipient. The child composer supports `/help` and `/agents attention`, with Tab completion; other built-in commands stay in Main.

Todo, Plan, pending interactions, Operation/Review and Main input coexist at supported terminal sizes of at least 40 columns and 12 rows. The status area shows the exact number of pending permissions and replies, independent of Fleet visibility and the composer. `Alt+A` or `/agents attention` opens the representative request; narrow layouts retain the count and shortcut, and the last resolved request restores the ordinary status. In a Main permission panel, `Alt+A later` returns without deciding; Escape retains its explicit denial behavior. Background requests do not take focus. A request in the displayed conversation, or one necessary for Main's exact current wait condition, exposes its blocking reason and handling action. It can open the processing panel when no draft or other interaction needs protection. A wait for any child does not require user action while another selected child can still complete. Explicitly deferring a request leaves its entry available without reopening it on every update. Handling and returning preserve the original view and draft. Dismissed Plan review remains dismissed until explicitly opened or its exact subject changes. `/exit` and Ctrl+Q use the same authoritative cleanup path; terminal modes are restored after settlement.

## Recovery and verification

Recovery reconstructs frozen Prompt/Skill/resource context and resource usage from canonical records. It validates the child admission link and exact resource occurrences, preserves exact task grants and historical budget policies, and never resends an acknowledged unfinished provider request. Historical control formats remain readable. Their old execution tools and managed-session capability requests are explicitly refused, and historical inspection never writes recovery or cancellation into the old manager log.

Focused tests cover role discovery and administration, target recovery, direct input, editable grants, Skills/Web, selected artifacts and cold recovery. The ordinary ProjectRuntime PTY spine verifies real JSONL child input, layered Escape handling, Main responsiveness and settled continuation. Full Linux Quality and the historical compatibility suites remain required before publication; deterministic tests alone do not establish model quality or production readiness.
