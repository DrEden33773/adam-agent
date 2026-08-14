# Adam Agent

Adam Agent is a lightweight, inspectable TypeScript coding agent for local software-engineering work.

The repository contains a provider-neutral Agent kernel with workspace-confined reads, create-only UTF-8 writes, exact multi-edit mutations, call-scoped permission requests, canonical event persistence through caller-supplied in-memory and durable project-scoped JSONL stores, cancellation, and per-run turn/token limits, backed by a deterministic fake model. Path confinement rejects traversal and symlink escape but is not an OS sandbox and does not claim protection from hostile concurrent filesystem mutation. The current one-shot CLI remains read-only; execute tools, resume, interactive terminal support, and live model providers have not been added yet. The accepted runtime is Node.js 24 LTS with pnpm 11; Bun is reserved for a later compatibility-tested distribution experiment.

## Development

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm hooks:install
pnpm quality:check
pnpm --silent adam "What is this repository?"
```

The `adam` command currently exercises the deterministic fake provider by reading `README.md`; it does not call a live model.

Use `pnpm quality:fix` only when an intentional formatting rewrite is desired. The pre-commit hook is check-only.

See [`AGENTS.md`](AGENTS.md) for the authoritative engineering contract.
