# Daily workflows

Start `adam` from the project you want to inspect. From a source checkout, build once and invoke the absolute `apps/tui/dist/main.js` entry while keeping that project as cwd. See [installation](local-installation.md) for the local launchers and [setup](setup-and-development.md) for model credentials.

## Input and tools

Tab completes slash commands and their supported arguments. `@` completion offers project paths and agent references; accept a row to preserve its precise identity. `/skills` selects Skills for the next turn. A path reference does not attach file bytes: use `/attach <path>` to stage an immutable input resource when needed.

Tool cards show the prepared action and its outcome. Ctrl+O opens bounded details; Ctrl+T toggles reasoning. Scroll or page upward to inspect earlier content, then return to the bottom to follow new output. `/history` loads earlier turns, `/tree` navigates complete conversation boundaries, and `/copy` copies the assistant answer.

Review every requested write or shell command before approval. A permission decision applies to the displayed call. `/plan` supports exploration and an explicit transition to approved implementation; Todos record progress without starting new work.

## Todos

Unfinished Todos stay in a compact tree. Completing the final item produces a short completion line, which leaves the fixed area when the Main run ends. `/todos` keeps the full list and history available; Alt+T or `/todos toggle` changes only the overlay's visibility.

New sessions allow the exact built-in Todo create/update operations under their recorded policy. This does not grant filesystem writes or execution. Older sessions keep their policy until an explicit idle upgrade through `/session settings`; pending requests and past records retain their original meaning.

## Child conversations and attention

Use a selected Explore or Research reference, or accept a model-requested delegation, to open the delegation review. Choose the task context, execution mode and any optional budget before confirming. Background tasks can progress while Main remains usable.

`/agents` opens the thread navigator. Enter opens a full Child page in browsing mode; another Enter opens its independent composer. Enter there sends to the displayed recipient. Escape returns to browsing while preserving the draft, then returns to the originating view. A retained draft never opens itself for editing.

The status area counts pending permissions and replies. Alt+A and `/agents attention` open the relevant items. Background requests do not take ordinary editing focus; a request that blocks the current execution path exposes a handling action. Returning from the panel restores the view and draft. Reading a Child result and delivering it to Main are separate actions; see [managed agents](managed-control-candidate.md).

## Archive, Trash and Restore

Open `/resume` to browse project sessions. Tab cycles Active, Archived and Trash. Search and selection remain available while history checks run.

- **Archive / Unarchive:** Ctrl+A changes the selected idle session's visibility. Ctrl+U undoes the latest visibility change. Archiving the current idle session returns to the list.
- **Trash:** Ctrl+D previews the selected Main and all its owned Child histories. Cancel is selected initially. Confirm only after checking the displayed unit.
- **Restore:** In Trash, select a unit and press Enter. Successful restoration retains its original identity and archive state; it does not restart a Child or model request.

Running, queued, pending or incompletely recovered work blocks Archive and Trash. Use the offered existing stop or recovery action explicitly before trying again. Ordinary derived branches are separate sessions: a dependency blocks Trash instead of deleting that branch. Restoration refuses an occupied destination.

An interrupted Trash/Restore operation remains visible as an unfinished transaction. Inspect it and use the displayed Continue or Restore action; startup does not silently finish a move. Shared artifacts remain outside the moved unit, and restoration verifies that retained references can still be read. There is no automatic emptying or permanent-delete action.

## Exit and reopen

Ctrl+Q or `/exit` settles local execution and restores terminal modes. Reopen `adam` from the same project to choose retained history, or use `adam --resume <session-id>` for an exact session. Cold inspection does not itself invoke the model. Submit a new prompt only when you want more work.

The headless `adam-cli --resume <session-id>` prints a hydrated snapshot. `--continue` explicitly resumes an interrupted logical run; branching is a separate operation. Main and Child drafts, Todo state and retained resource references remain local session data when you switch or uninstall application versions.
