# Local installation

Build Adam once and carry the resulting archive to another directory or compatible Linux machine. Running the installed CLI and TUI needs Node.js 24, but no source checkout, compiler or pnpm. Use the same CPU architecture and a compatible libc as the build machine.

## Build and unpack

From an Adam source checkout with Node.js 24 and the pinned pnpm version:

```sh
pnpm install --frozen-lockfile
pnpm package:local /tmp/adam-package
mkdir -p /tmp/adam-unpacked
tar -xzf /tmp/adam-package/adam-*.tar.gz -C /tmp/adam-unpacked
node /tmp/adam-unpacked/adam-*/install.mjs install "$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"
```

Choose a new output directory for each build. The packaging command refreshes all generated output, copies the installed production dependency closure, includes native tools and the Pi patch, checks that symlinks stay inside the package, and writes a gzip tar archive. `local-package.json` records the revision, working-tree status, platform and dependency/license inventory. The README, public guides, screenshots, dependency licenses and third-party notices travel with the application. The application version identifies the source revision; a package built with local edits also carries `-worktree`.

To move the archive, copy the `.tar.gz` file, extract it at the destination, and run its `install.mjs` command there. The archive contains application files; configuration and session history are stored separately.

## Run from your project

Open a terminal in the project you want Adam to work on, then run:

```sh
adam
```

The launcher preserves your current directory. Adam reads project configuration and `.env` from that project, user configuration from `$XDG_CONFIG_HOME` (default `~/.config`), and sessions from `$ADAM_AGENT_STATE_ROOT` (default `~/.local/state/adam-agent`). Select a model in the TUI and configure its credentials as described in [model setup](../README.md). The first launch asks you to trust the project.

`adam-cli` runs the one-shot CLI. For an explicitly offline example, create a `README.md` in a temporary project and run:

```sh
adam-cli --trust-workspace
ADAM_AGENT_TARGET=fake.local adam-cli "Summarize README.md"
```

The fake target reads the first README paragraph through the ordinary file tool and returns a deterministic answer. It does not contact a model provider.

## Switch or uninstall versions

Installing a different revision adds a version under `<prefix>/lib/adam-agent/` and activates it. Existing versions are never overwritten. Use the version shown by the installer or listed in that directory:

```sh
node "$HOME/.local/lib/adam-agent/current/install.mjs" use "$HOME/.local" VERSION
node "$HOME/.local/lib/adam-agent/current/install.mjs" uninstall "$HOME/.local" VERSION
```

Replace `VERSION` with the exact installed directory name. Uninstalling the active version removes the `adam` and `adam-cli` launchers; activate another installed version through its own `install.mjs` to recreate them. Installing, switching and uninstalling manage only Adam application files. They preserve project files, session history, credentials and user configuration. An existing unrelated `adam` or `adam-cli` command in the chosen prefix is refused; choose another prefix if those names are already in use.
