# Adam Agent

Adam Agent is a lightweight, inspectable TypeScript coding agent for local software-engineering work.

The repository contains a provider-neutral Agent kernel with four model-facing coding tools (`read_file`, `write_file`, `edit_file`, and `run_shell`), call-scoped permission requests, canonical event persistence through caller-supplied in-memory and durable project-scoped JSONL stores, cancellation, bounded shell output with durable content-addressed overflow artifacts, and per-run turn/token limits, backed by a deterministic fake model. Filesystem path confinement rejects traversal and symlink escape, while approved shell commands run from the project root with a minimal environment and mandatory timeout/process-group cleanup. Neither mechanism is an OS sandbox or network isolation boundary, and the shell must only be used for trusted local work after reviewing each command. Resume, an interactive terminal UI, and live model providers have not been added yet. The accepted runtime is Node.js 24 LTS with pnpm 11; Bun is reserved for a later compatibility-tested distribution experiment.

## Development

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm hooks:install
pnpm quality:check
pnpm --silent adam "What is this repository?"
```

The `adam` command currently exercises deterministic read, edit, and shell scenarios through the fake provider; it asks on stderr before write or execute effects and does not call a live model. Session JSONL and overflow artifacts are written under `ADAM_AGENT_STATE_ROOT` when set, otherwise under `~/.local/state/adam-agent`.

Use `pnpm quality:fix` only when an intentional formatting rewrite is desired. The pre-commit hook is check-only.

See [`AGENTS.md`](AGENTS.md) for the authoritative engineering contract.
