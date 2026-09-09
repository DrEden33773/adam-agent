# Text reads and atomic Todo updates

## Read a text range

Current `read_file` definitions accept a workspace-relative `path`, an optional 1-based `startLine`, and an optional `maxLines` (default 200, maximum 2,000). Ordinary workspace confinement and read permission apply.

```json
{"path":"src/large.ts","startLine":3501,"maxLines":40}
```

The result contains `content`, `truncated`, `reason`, `fileVersion`, `byteRange`, `lineRange`, and `nextRead`. `byteRange.start` is inclusive and `endExclusive` is exclusive. `lineRange` identifies the absolute lines returned when reading from byte zero; it is null for an explicit byte-offset read or an empty result. A long line may occupy several pages.

Each call reads at most 8 MiB of source bytes and returns at most 64 KiB of complete JSON, including escaped text and metadata. `reason` is `eof`, `line_limit`, `output_limit`, or `scan_limit`. A bounded scan can return empty content before reaching the requested line. It still returns a usable continuation and never claims it reached the target.

Pass the complete returned `nextRead` object as the next call's input. It includes `byteOffset`, `startLine`, `maxLines`, and `expectedFileVersion`. With `byteOffset`, `startLine` is relative to that offset; this preserves any remaining lines to skip after a scan limit. Returned offsets preserve UTF-8 boundaries, including BOM characters. At EOF, `nextRead` is null. If the file changes, restart the read instead of combining pages from different versions. A supplied offset that splits a UTF-8 code point fails validation during reading.

Invalid input feedback names supported fields and correction rules without reproducing unknown keys or supplied values. Binary or invalid UTF-8 ranges fail with a typed result. Cancellation stops the read and closes its file handle through the ordinary session cancellation path.

## Update several Todos atomically

`update_todo` retains its single-item behavior. Use `update_todos` to apply 1–16 distinct mutations against one current store snapshot:

```json
{
  "expectedStoreRevision":4,
  "updates":[
    {"id":"018fd329-cdb7-7d57-a4ec-ab2c94863bb1","expectedItemRevision":1,"status":"completed"},
    {"id":"018fd329-cdb7-7d57-a4ec-ab2c94863bb2","expectedItemRevision":1,"status":"completed"}
  ]
}
```

Each update uses the existing title, details, status, and dependency limits. Current create, single-update and batch-update definitions additionally accept optional `activeForm`, a nonempty string of at most 512 UTF-8 bytes. This is explicit model-authored display text; omission leaves the title as the display fallback, and an update with `activeForm: null` removes the field. Changes obey the same revisions and no-op rules. Known stale or invalid batches are rejected before permission; the session revalidates before committing. A batch receives one exact call-scoped permission decision. Duplicate targets, stale revisions, no-op mutations, cycles, or invalid final dependency states reject the entire batch. A prerequisite and dependent can become completed together, regardless of their order in the batch.

Success increments each changed item revision once and the store revision once. The output contains `batchVersion: 1`, `policyVersion: "todo-policy.v1"`, `storeRevision`, and the complete changed `items`. One canonical `tool_completed` record carries both the atomic mutation and its model-visible result. Complete-record recovery therefore cannot preserve a success result without its corresponding Todo state. An interrupted write that cannot prove commitment retains the existing indeterminate-effect handling and never automatically replays the mutation.

The authoritative Todo projection consumes that same record for model summaries, compaction, resume, prefix branches, `/todos`, and compact status. New sessions record `todo-permission.session-v1`, which defaults the exact built-in create/update/batch Todo operations to allow unless the ordinary policy denies them. New Plan cycles use the corresponding Todo-enabled hybrid policy; the original read/hybrid/delegation Plan versions continue to deny Todo mutations. Older sessions retain `todo-permission.legacy-v1` semantics until an explicit idle upgrade through `/session settings`. The upgrade appends a record, preserves old JSONL and pending identities, and affects future calls and new Plan cycles. Branches inherit the policy at their selected source prefix. Todo never starts another turn, and TUI navigation remains read-only.

## Frozen tool definitions

New sessions receive the current definitions. A persisted Tool Profile keeps its exact definitions and digests: an older `read_file` profile still uses its original path-only, bounded-prefix adapter and original result shape on continuation, safe replay, and Plan execution. Adding a new command does not add it to an existing frozen profile. Historical records and already admitted tool intents are not rewritten.

The original Todo mutation definitions remain available only to their exact historical profiles and reject `activeForm`. Current definitions admit the field without changing the Todo policy, record or atomic-batch version. Resume, compaction and branch inheritance preserve explicit values; records without the field remain unchanged.
