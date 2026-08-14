# Adam Agent

Adam Agent is a lightweight, inspectable TypeScript coding agent for local software-engineering work.

The repository contains a provider-neutral Agent kernel with root-confined read, recursive list, and literal text-search tools, canonical event persistence through caller-supplied in-memory and durable project-scoped JSONL stores, cancellation, and per-run turn/token limits, backed by a deterministic fake model. Write and execute tools, approval prompts, resume, interactive terminal support, and live model providers have not been added yet. The accepted runtime is Node.js 24 LTS with pnpm 11; Bun is reserved for a later compatibility-tested distribution experiment.

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
