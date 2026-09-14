# Headless jobs

`adam-cli --job /absolute/job.json` runs one Main task from the caller's current project directory. It uses the production Lifecycle, coding tools, model targets and persistent sessions. Delegation is disabled. Ordinary CLI and TUI commands retain their existing behavior.

The job file is Owner-controlled configuration. Job startup does not load the project's `.env`; credentials come from the caller's environment. Give every independent task its own state and configuration directories. Keep these directories and the job file outside the repository being edited.

```json
{
  "version": 1,
  "prompt": "Investigate and fix the reported issue, then run relevant tests.",
  "target": "deepseek-flash.direct",
  "stateRoot": "/absolute/job-state",
  "configurationRoot": "/absolute/job-config",
  "trustWorkspace": true,
  "maxTurns": 80,
  "timeoutMs": 1800000,
  "thinking": "high"
}
```

All fields above except `thinking` are required. `maxTokens` is an optional positive limit. The example limits are illustrative; choose and record them for your workload. `trustWorkspace: true` explicitly grants trust to the caller's project through Lifecycle; false retains its existing trust state. The job file is limited to 1 MiB and rejects unknown fields. The explicit `fake.local` target provides the existing offline CLI examples.

## Controller protocol

Stdout is newline-delimited JSON. Every frame has `version: 1`, a monotonically increasing `sequence`, `type`, and `value`. Keep stdin open while the job is running. Runtime events use type `event`; `admitted` contains the authoritative session/run receipt; `configured` records the target and context profile; `model_usage` includes call identity and purpose; `control_result` acknowledges a permission decision. Diagnostics are separate from the JSON stream.

Read operations are allowed; write and execute operations request an exact decision. A controller can answer a `tool_permission_requested` runtime event using its `requestId`:

```json
{"type":"permission","requestId":"the-exact-request-id","decision":"allow"}
```

Use `deny` to refuse the operation. A stale or unknown request, malformed control input, EOF, explicit cancellation, SIGINT, SIGTERM, or the job deadline cancels the task. Control buffering is bounded. A controller cancellation is:

```json
{"type":"cancel"}
```

The final `result` frame includes the admission receipt, product result, accumulated usage, close status, stop reason and any startup/infrastructure failure. Exit 0 requires a completed product result, confirmed close and no controller/runtime failure. An answer or successful exit is not independent evidence that a coding task's tests passed. If the process is forcibly killed or stdout becomes unavailable, the controller must record that absence rather than invent a product terminal result.

Usage includes ordinary, automatic-title and compaction model calls. Missing usage is counted as `unknownCalls`; it is not free usage. Reasoning and cached tokens are details of output/input respectively, not additional tokens to double-count. Token limits are runtime limits, not a strict currency cap, and an interrupted request can have unreported upstream cost.

## Model relay

The optional `modelRelay` field accepts an HTTP(S) origin for the `deepseek-flash.direct` target. The caller supplies `ADAM_AGENT_RELAY_TOKEN`; Adam sends that task credential to the relay's `/responses`, using the ordinary DeepSeek Responses driver and exact request body. Other upstream destinations and redirects are refused. Keep real provider credentials at the relay if you use this mode. Plain HTTP is intended only within a trusted isolated network.

The relay, controller and task environment must enforce their own network and resource policy. This option is not a general proxy or an OS sandbox. In particular, denying network tool effects does not stop an approved shell command from networking. Avoid exposing the Docker socket, host data, other tasks, hidden test assets or provider credentials to untrusted task code.
