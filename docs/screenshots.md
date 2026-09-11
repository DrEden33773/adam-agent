# Screenshot provenance

The README images are direct captures of the installed Adam application in a Linux xterm window using DejaVu Sans Mono and the application's normal terminal colors. The main image uses 120 columns and 46 rows; the Child and permission images use 120 columns and 36 rows. No product UI, text or result was composited into the images.

The demonstration uses a temporary project with a small path-resolution helper and two Node tests. A deterministic external provider fixture supplies model responses. Adam performs the real repository search, file reads, Todo writes, Child delegation and follow-up, parent reply handling, exact-call permission, and `node --test paths.test.mjs` execution. The command exits successfully with two passing tests. The images illustrate product interaction rather than live-provider quality or timing.

| Image | Captured state |
| --- | --- |
| [Main workflow](images/main-workflow.png) | An approved test command, completed Todo, final answer, and a separate next-prompt draft. |
| [Child conversation](images/child-conversation.png) | The completed Child's full transcript and an explicitly opened independent follow-up editor. |
| [Permission](images/permission.png) | The actual shell command waiting for its exact permission decision, with Todo and pending-item status visible. |

The same isolated session was archived, unarchived, moved to Trash with both owned Child histories, restored and reopened in a cold process. All three session logs were restored byte-for-byte, the retained Child draft remained readable, and lifecycle operations plus cold inspection made no further provider request. Raw sessions, provider fixtures and terminal streams are kept outside the public repository.
