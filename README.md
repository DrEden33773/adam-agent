# Adam Agent

Adam Agent is a lightweight, inspectable TypeScript coding agent for local software-engineering work.

The repository contains a provider-neutral Agent kernel with four model-facing coding tools (`read_file`, `write_file`, `edit_file`, and `run_shell`), call-scoped permission requests, canonical event persistence through caller-supplied in-memory and durable project-scoped JSONL stores, cancellation, bounded shell output with durable content-addressed overflow artifacts, and per-run turn/token limits. A deterministic fake model remains the default, while an environment-selected OpenAI-compatible Adapter provides the first live DeepSeek path. Filesystem path confinement rejects traversal and symlink escape, while approved shell commands run from the project root with a minimal environment and mandatory timeout/process-group cleanup. Neither mechanism is an OS sandbox or network isolation boundary, and the shell must only be used for trusted local work after reviewing each command. Resume and an interactive terminal UI have not been added yet. The accepted runtime is Node.js 24 LTS with pnpm 11; Bun is reserved for a later compatibility-tested distribution experiment.

## Development

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm hooks:install
pnpm quality:check
pnpm --silent adam "What is this repository?"
```

With no provider environment variable, the `adam` command exercises deterministic read, edit, and shell scenarios through the fake provider. It asks on stderr before write or execute effects. Session JSONL and overflow artifacts are written under `ADAM_AGENT_STATE_ROOT` when set, otherwise under `~/.local/state/adam-agent`.

To use the live DeepSeek Adapter, supply the credential from the environment and select the provider explicitly:

```bash
export DEEPSEEK_API_KEY="..."
ADAM_AGENT_PROVIDER=deepseek pnpm --silent adam "Summarize this repository"
```

The default live model is `deepseek-v4-pro`; set `ADAM_AGENT_MODEL` to override it, for example `deepseek-v4-flash`. Adam sends requests only to `https://api.deepseek.com` in this slice and does not persist credentials, raw provider responses, or reasoning content. Provider failures are reduced to bounded Adam-owned metadata before session persistence. The live model can request the same four tools as the fake path, and write or execute effects still require the existing call-scoped approval.

With `DEEPSEEK_API_KEY` already present, the opt-in live smoke gate runs one answer-only turn and one real read-tool round trip:

```bash
ADAM_AGENT_LIVE_TESTS=1 pnpm exec vitest run packages/testkit/src/openai-compatible-model-driver.live.test.ts
```

Use `pnpm quality:fix` only when an intentional formatting rewrite is desired. The pre-commit hook is check-only.

See [`AGENTS.md`](AGENTS.md) for the authoritative engineering contract.
