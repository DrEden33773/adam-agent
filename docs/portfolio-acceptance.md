# Portfolio acceptance and walkthrough

Adam is a Linux-supported source-checkout portfolio checkpoint. The application workspace and CLI/TUI packages are private `0.0.0` packages, not an npm or standalone-binary distribution, and this document does not claim production readiness or semantic release compatibility.

## Evidence vocabulary

| Label | Certifies | Does not certify |
| --- | --- | --- |
| Deterministically tested | Repeatable credential-free behavior at an Adam public or caller-visible seam. | Live provider availability, model quality, or an external OS contract. |
| Real OS/PTY tested | A distinct Linux process, PTY, signal, transport, filesystem, or terminal-restoration contract. | Every terminal emulator, cross-platform behavior, or model quality. |
| Live-provider observed | One bounded run against the recorded exact target and profile. | Universal reliability, comparative quality, or future provider behavior. |
| Human walkthrough observed | One retained end-to-end workflow with independently checked repository and terminal outcomes. | Unattended autonomy, hostile-workspace safety, or statistical quality. |

`Supported` means the current Linux source-checkout path is part of the required Quality contract. `Experimental` identifies an explicit path that is excluded from certification. `Not implemented` is used for absent behavior rather than implying future compatibility. Certified is an Adam code-level conformance status, not a provider endorsement.

## Acceptance matrix

| Claim | Certifying evidence | Supplementary evidence | Failure meaning |
| --- | --- | --- | --- |
| Source checkout builds and tests | `pnpm quality:check` passes from an exact clean candidate commit on the required Ubuntu 24.04 hosted runner. | Focused workspace tests and locally recorded toolchain versions make diagnosis reproducible. | The portfolio checkpoint is not reproducible and cannot close. |
| TUI terminal lifecycle is reliable | The required real-process and PTY suite passes through Quality and `pnpm test:tui:os` on Linux. | `pnpm test:tui:behavior` isolates renderer-neutral lifecycle and presentation behavior. | A terminal, signal, transport, or restoration failure blocks the claim and merge. |
| Headless CLI is composable | The CLI process and deterministic coding-flow tests pass through Quality with stdout, stderr, exit, and persisted-state assertions. | A disposable-repository transcript may illustrate the same contract. | Stream separation, terminal status, or coding-flow behavior is not accepted. |
| Permissions match the documented trust boundary | Approval, built-in path-confinement, shell, MCP, extension, credential, and owner-only state tests pass through Quality. | `/help safety` and the security table make the tested boundary caller-visible. | The affected boundary must be corrected or narrowed before publication. |
| Sessions resume without implicit continuation | Deterministic CLI and TUI tests prove cold hydration, explicit continuation, and immutable-prefix branching through Quality. | The live walkthrough repeats cold hydration and read-only continuation against one retained public session ID. | Resume semantics are not accepted if hydration invokes a model or effect, or continuation corrupts history. |
| Live provider completes the bounded walkthrough | One retained exact-candidate run uses `deepseek-v4-flash.direct`, the public fixture, exact-call approvals, a passing focused test, cold resume, and read-only verification. | The credential-free fixture and deterministic target/profile conformance tests constrain interpretation. | The live-provider and human-walkthrough labels remain unobserved; deterministic evidence alone cannot close B9-H1. |
| Public claims remain bounded | The public-product contract guard and independent review pass on the exact candidate, and hosted Quality passes before merge. | Manual inspection compares README, runbook, CLI help, TUI process help, and `/help safety`. | Any unsupported distribution, platform, sandbox, parity, effects, API-stability, or model-quality claim blocks publication. |

## Reproduce the deterministic and terminal gates

Use Node.js 24 and the exact pnpm 11 release declared by `packageManager`. Start from a clean exact commit, retain the reported SHA with the evidence, and do not set `NODE_TLS_REJECT_UNAUTHORIZED=0`.

```bash
git rev-parse HEAD
git status --porcelain=v1
uname -a
cat /etc/os-release
node --version
corepack pnpm --version
pnpm install --frozen-lockfile
pnpm quality:check
pnpm exec vitest run packages/testkit/src/public-product-contract.test.ts
pnpm test:tui:behavior
pnpm test:tui:os
```

The complete Quality command is the certifying deterministic regression gate. The two TUI commands are focused diagnostic and acceptance views of the same required suite; they are not optional substitutes for Quality.

## Headless acceptance

The headless process contract keeps final answers on stdout, approval requests and failures on stderr, and terminal status in the exit code. `--resume` without `--continue` hydrates only; explicit continuation and immutable-prefix branching are separate operations. Focused repeatable evidence is available with:

```bash
pnpm exec vitest run apps/cli/src/main.test.ts -t "answers a repository question through one read-only tool turn"
pnpm exec vitest run apps/cli/src/main.test.ts -t "edits, verifies, and persists one approved coding task"
pnpm exec vitest run apps/cli/src/main.test.ts -t "continues an interrupted logical run in a new attempt without duplicating its user message"
pnpm exec vitest run apps/cli/src/main.test.ts -t "branches an immutable complete parent boundary into an independently hydratable child"
```

Manual CLI transcripts must use a disposable working repository and an explicit temporary `ADAM_AGENT_STATE_ROOT`; they must not write acceptance state into the user's normal Adam state root.

## Security and trust boundary

| Boundary | Active statement |
| --- | --- |
| Exact-call approval | Write and execute effects require a decision for the exact prepared call under the default policy. Approval does not contain the resulting code or process. |
| Built-in file path confinement | First-party file tools reject lexical traversal and symlink escape from the canonical workspace under the documented trusted-local threat model. |
| Same-user shell and MCP processes | Approved shell commands and trusted MCP servers run with the invoking user's authority; deadlines, environment bounds, process groups, and cleanup are lifecycle controls. |
| Trusted in-process extensions | Exact Owner-configured extension packages are validated before activation but execute as trusted JavaScript in the Adam process. |
| External plaintext credentials | Provider credentials remain external environment or owner-managed `.env` input; `.env` is plaintext and must never enter transcripts, model context, or committed evidence. |
| Owner-only local state | Session logs, artifacts, configuration, and operation data use documented owner-only local locations, but local modes are not protection from every same-user process or backup. |
| No OS, process, or network sandbox | Adam does not provide hostile-code confinement or network isolation; review every command, MCP server, extension package, and repository before granting authority. |

Adam does not claim safe unreviewed shell execution, exactly-once external effects, hostile same-user concurrency protection, cross-platform support, full Pi/Codex/Claude parity, stable public application APIs, or model-quality improvement.

## Live coding walkthrough contract

The retained walkthrough uses `deepseek-v4-flash.direct` and the public [`examples/portfolio-walkthrough`](../examples/portfolio-walkthrough) fixture. The fixture has two TypeScript source files, one intentionally failing focused test, a repository `AGENTS.md`, no third-party dependency, and one permitted source file to repair. Never edit the committed fixture in place; prepare a clean disposable Git repository:

```bash
ADAM_CHECKOUT="$(pwd)"
WALKTHROUGH_ROOT="$(mktemp -d)"
WALKTHROUGH_STATE="$(mktemp -d)"
cp -R examples/portfolio-walkthrough/. "$WALKTHROUGH_ROOT/"
git -C "$WALKTHROUGH_ROOT" init -q
git -C "$WALKTHROUGH_ROOT" add .
git -C "$WALKTHROUGH_ROOT" -c user.name=Adam -c user.email=adam@example.invalid commit -qm fixture
pnpm --dir "$WALKTHROUGH_ROOT" test
pnpm build
```

The initial test command must fail with an actual total of 2,000 cents and an expected total of 2,700 cents. Start the production entry from the fixture root without copying credentials or state into it:

```bash
cd "$WALKTHROUGH_ROOT"
node --env-file-if-exists="$ADAM_CHECKOUT/.env" "$ADAM_CHECKOUT/apps/tui/dist/main.js" --target deepseek-v4-flash.direct --state-root "$WALKTHROUGH_STATE"
```

Use this task prompt: `Repair the quantity-discount bug. Follow AGENTS.md, run the focused test, inspect the resulting diff, and report the verified result.` The task must make Adam inspect the repository, read the applicable instructions and files, request exact approval for one bounded structured edit, request separate execute approval for `pnpm test`, expose the canonical diff, explain the verified result, and leave only the expected source change. Open `/session` and record the public session ID, exit normally, then restart the same production entry with `--resume <session-id> --state-root "$WALKTHROUGH_STATE"`. Hydration must perform no model request or effect. Explicitly submit `Without changing files, verify which file changed and whether the focused test passed.` and approve no mutation; the answer must agree with Git and the retained test result.

Only a bounded summary may be public: exact Adam commit, exact target/profile, public fixture digest or contents, prompts, approval subjects and decisions, selected verification commands, exit statuses, Git diff summary/digest, cold-hydration result, continuation result, and terminal restoration. Credentials, `.env`, raw session JSONL, owner-only artifacts, private absolute paths, raw provider reasoning, and unredacted transcripts remain private.

## Current closeout

B9-H1 remains open until the deterministic and terminal gates pass on the exact candidate commit, the public fixture is present, the retained live walkthrough satisfies the contract above, public claims are independently reviewed, hosted Quality passes, and the exact merged `main` commit is verified. A successful fixture or live request alone is not completion evidence.
