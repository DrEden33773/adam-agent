# Managed-control candidate

The internal managed-control composition exercises ordinary child threads through `ManagedAgentControl`, the existing `AgentSession` loop, and shared Lifecycle/Presentation owners. It is selected by the internal test composition. The default product entry and the public managed-review extension capability retain their existing execution paths.

## Roles and authority

Explore receives repository reads, explicitly selected immutable input resources, its own frozen Skill catalog, and bounded parent coordination. Research adds the exact Web tools available to Main. An unconfigured search provider exposes no `web_search`; fetch uses normal network permission, while open/find read immutable evidence without another network request. Children cannot write, execute shell commands, access MCP or ambient extensions, or create other children. Skill content does not grant authority.

Each new thread freezes its role definition, exact certified target, effective context and thinking policy, initial context, permissions and budget. Unconfigured roles inherit Main's effective target and limits. A configured but unavailable target requires an explicit Use inherited, Update, or Cancel choice. Reloading definitions or the parent Skill catalog affects future threads. Existing threads retain their frozen definitions and independently activated Skills.

The candidate Plan policy, `plan-policy.hybrid-delegation-v1`, admits only the registered non-mutating role/control and Main/Research Web families under their ordinary permissions. Current Plan and permission ceilings remain enforceable at execution, queued work and recovery boundaries. Compatible work can continue while Plan is active. Plan approval is never delegated to a child.

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

A leading selected role opens a delegation review before admission. The same surface supports model-requested delegation through the pending permission owner. It exposes context choice, removable Skill pre-activations, execution mode, numeric presets and Custom limits, plus the complete grant and policy identities. An empty new-session draft creates its parent Session only after confirmation and validation, without a Main provider turn. Folded pasted text is included in the delegated task and remains subject to the task size limit.

Only explicitly selected input artifacts are linked into the child. Direct attachments use staged immutable bytes; model calls name exact parent occurrence IDs in `entries[].artifacts`. The runtime resolves those IDs through validated parent history, records their source boundary, and binds bounded `read_input_resource` access to the selected child occurrences. New turns preserve prior attachments and may explicitly add more. Attachments cannot be sent as cooperative input into a currently running turn; the draft remains available until a new turn can accept them. Unsupported media remain subject to the receiving target's normal resource capabilities.

Task only, Current request and Selected messages govern initial text sharing. Complete parent history, later messages, configuration changes and other child completions are not automatically copied. Later input uses an exact post, parent-input reply or new-turn receipt. Accepted input, delivered input, settled completion, user-seen state and Main consumption are distinct durable facts.

## Recovery and verification

Recovery reconstructs frozen Prompt/Skill/resource context and resource usage from canonical records. It validates the child admission link and exact resource occurrences, preserves run and thread budgets, and never resends an acknowledged unfinished provider request. Historical control formats remain readable without becoming executable through the candidate.

Focused tests cover role discovery and administration, target recovery, direct input, editable grants, Skills/Web, selected artifacts and cold recovery. The candidate ProjectRuntime PTY spine verifies real JSONL child input, layered Escape handling, Main responsiveness and settled continuation. Full Linux Quality and the historical compatibility suites remain required before publication; deterministic tests alone do not establish model quality or production readiness.
