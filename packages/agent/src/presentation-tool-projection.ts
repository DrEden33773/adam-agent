import type {
  PendingInteraction,
  ToolCallDisplay,
  ToolPreviewDisplay,
} from "@adam-agent/presentation";
import type { ArtifactReference, ChangePreviewArtifactSource } from "./artifact-store.js";
import type { SessionRecord } from "./session-store.js";
import type { JsonValue, PermissionSubject, ToolEffect } from "./tool-runtime.js";

type PresentationToolHistoryRecord = {
  readonly sessionId: string;
  readonly entry: SessionRecord;
};

export type ChangePreviewProjectionRequest = {
  readonly name: "write_file" | "edit_file";
  readonly reference: NonNullable<ToolCallDisplay["changePreviewRef"]>;
};

type MutableToolDisplay = {
  sessionId: string;
  callId: string;
  sequence?: number;
  name?: string;
  source?: NonNullable<ToolCallDisplay["source"]>;
  effect?: ToolEffect;
  subject?: PermissionSubject;
  status: ToolCallDisplay["status"];
  output?: JsonValue;
  failure?: { readonly code: string; readonly reason?: string; readonly message: string };
  changePreviewRef?: NonNullable<ToolCallDisplay["changePreviewRef"]>;
};

function collectMutableToolDisplays(
  records: readonly PresentationToolHistoryRecord[],
): ReadonlyMap<string, MutableToolDisplay> {
  const tools = new Map<string, MutableToolDisplay>();
  const toolFor = (sessionId: string, callId: string): MutableToolDisplay => {
    const key = `${sessionId}:${callId}`;
    const existing = tools.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created: MutableToolDisplay = { sessionId, callId, status: "requested" };
    tools.set(key, created);
    return created;
  };

  for (const { entry, sessionId } of records) {
    if (entry.schemaVersion !== 3) {
      continue;
    }
    if (entry.record.type === "model_response_completed") {
      for (const intent of entry.record.response.toolIntents) {
        const tool = toolFor(sessionId, intent.callId);
        tool.name = intent.name;
        tool.source = {
          provenance: "provider_model_response",
          sessionId,
          responseSequence: entry.sequence,
          argumentsDigest: intent.argumentsDigest,
          definitionDigest: intent.definitionDigest ?? null,
          replay: intent.replay,
        };
        if (intent.effect !== undefined) {
          tool.effect = intent.effect;
        }
      }
      continue;
    }
    if (entry.record.type !== "runtime_event") {
      continue;
    }
    const event = entry.record.event;
    if (event.type === "tool_requested") {
      const tool = toolFor(sessionId, event.callId);
      tool.sequence = entry.sequence;
      tool.name = event.name;
    } else if (event.type === "tool_permission_requested") {
      const tool = toolFor(sessionId, event.callId);
      tool.effect = event.effect;
      tool.subject = event.subject;
      tool.status = "permission_required";
      if (event.changePreviewRef !== undefined) {
        tool.changePreviewRef = presentationChangePreviewRef(event.changePreviewRef);
      }
    } else if (event.type === "tool_permission_decided") {
      const tool = toolFor(sessionId, event.callId);
      if (event.effect !== undefined) {
        tool.effect = event.effect;
      }
      if (event.subject !== undefined) {
        tool.subject = event.subject;
      }
      if (event.changePreviewRef !== undefined) {
        tool.changePreviewRef = presentationChangePreviewRef(event.changePreviewRef);
      }
      tool.status = event.decision === "allow" ? "requested" : "denied";
    } else if (event.type === "tool_started") {
      const tool = toolFor(sessionId, event.callId);
      tool.status = "running";
    } else if (event.type === "tool_completed") {
      const tool = toolFor(sessionId, event.callId);
      tool.status = "completed";
      tool.output = event.output;
    } else if (event.type === "tool_failed") {
      const tool = toolFor(sessionId, event.callId);
      tool.status = event.error.code === "permission_denied" ? "denied" : "failed";
      tool.failure = {
        code: event.error.code,
        ...(event.error.code === "tool_effect_indeterminate" ? { reason: event.error.reason } : {}),
        message: boundedDisplayText(event.error.message),
      };
    }
  }

  return tools;
}

export function projectToolDisplays(
  records: readonly PresentationToolHistoryRecord[],
  changePreviewCache: ReadonlyMap<string, ToolPreviewDisplay | null>,
): ReadonlyMap<string, ToolCallDisplay> {
  const tools = collectMutableToolDisplays(records);
  return new Map(
    [...tools.entries()].flatMap(([key, tool]) => {
      if (tool.sequence === undefined) {
        return [];
      }
      const name = tool.name ?? "unknown";
      const subject = safeToolSubject(tool.subject, tool.output);
      return [
        [
          key,
          {
            type: "tool_call" as const,
            id: `${tool.sessionId}:${tool.sequence}`,
            sequence: tool.sequence,
            sourceSessionId: tool.sessionId,
            branchBoundary: null,
            callId: tool.callId,
            qualifiedName: name,
            kind: toolKind(name),
            effect: tool.effect ?? null,
            label: toolLabel(name),
            subject,
            source: tool.source ?? null,
            durationMs: null,
            status: tool.status,
            outcome: toolOutcome(tool),
            resultSummary:
              tool.failure === undefined
                ? toolResultSummary(name, tool.output)
                : `${tool.failure.code}: ${tool.failure.message}`,
            artifacts: toolArtifacts(tool.output),
            changePreviewRef: tool.changePreviewRef ?? null,
            preview: toolPreview(
              name,
              tool.output,
              subject,
              tool.changePreviewRef,
              changePreviewCache,
            ),
          },
        ] as const,
      ];
    }),
  );
}

export function projectPendingPermissionCandidates(
  records: readonly PresentationToolHistoryRecord[],
): readonly Extract<PendingInteraction, { readonly type: "permission" }>[] {
  const decided = new Set(
    records.flatMap(({ entry, sessionId }) =>
      entry.schemaVersion === 3 &&
      entry.record.type === "runtime_event" &&
      entry.record.event.type === "tool_permission_decided" &&
      entry.record.event.requestId !== undefined
        ? [`${sessionId}:${entry.record.event.requestId}`]
        : [],
    ),
  );
  return records.flatMap(({ entry, sessionId }) => {
    if (
      entry.schemaVersion !== 3 ||
      entry.record.type !== "runtime_event" ||
      entry.record.event.type !== "tool_permission_requested" ||
      decided.has(`${sessionId}:${entry.record.event.requestId}`)
    ) {
      return [];
    }
    const subject = safeToolSubject(entry.record.event.subject, undefined);
    if (subject === null) {
      return [];
    }
    const changePreviewRef =
      entry.record.event.changePreviewRef === undefined
        ? null
        : presentationChangePreviewRef(entry.record.event.changePreviewRef);
    return [
      {
        type: "permission" as const,
        requestId: entry.record.event.requestId,
        callId: entry.record.event.callId,
        effect: entry.record.event.effect,
        subject,
        ...(entry.record.event.subject?.type === "plan_command"
          ? {
              warning:
                "Plan parsing is not a sandbox. Approval may run project code, write cache or artifacts, read accessible data, or use network.",
            }
          : entry.record.event.subject?.type === "managed_agent_web_request"
            ? {
                warning: `Allow ${entry.record.event.subject.agentId} (research.v1) to send this exact Web request to ${entry.record.event.subject.providerOrigin}: ${entry.record.event.subject.queryOrUrl}?`,
              }
            : entry.record.event.subject?.type === "web_request"
              ? {
                  warning: isLiteralLoopbackProviderOrigin(
                    entry.record.event.subject.providerOrigin,
                  )
                    ? "Adam will connect only to the exact configured loopback SearXNG endpoint. Adam does not install, start, monitor, or recover that service."
                    : "This public operator can receive this exact Web request and network address. Adam will not verify, replace, or fall back from this endpoint.",
                }
              : {}),
        canAllow: entry.record.event.effect !== "write",
        changePreviewRef,
      },
    ];
  });
}

export function collectChangePreviewRequests(
  records: readonly PresentationToolHistoryRecord[],
  knownPreviewIds: ReadonlySet<string>,
): readonly ChangePreviewProjectionRequest[] {
  const seen = new Set(knownPreviewIds);
  return [...collectMutableToolDisplays(records).values()].flatMap((tool) => {
    const name = tool.name;
    const reference = tool.changePreviewRef;
    if (
      (name !== "write_file" && name !== "edit_file") ||
      reference === undefined ||
      seen.has(reference.id)
    ) {
      return [];
    }
    seen.add(reference.id);
    return [{ name, reference }];
  });
}

export function resolveActionableChangePreviewReference(
  records: readonly PresentationToolHistoryRecord[],
  activeSessionId: string,
  requestId: string,
): ArtifactReference<ChangePreviewArtifactSource> | null {
  const requested = records.findLast(
    ({ entry, sessionId }) =>
      sessionId === activeSessionId &&
      entry.schemaVersion === 3 &&
      entry.record.type === "runtime_event" &&
      entry.record.event.type === "tool_permission_requested" &&
      entry.record.event.requestId === requestId,
  );
  if (
    requested?.entry.schemaVersion !== 3 ||
    requested.entry.record.type !== "runtime_event" ||
    requested.entry.record.event.type !== "tool_permission_requested" ||
    requested.entry.record.event.changePreviewRef === undefined ||
    records.some(
      ({ entry, sessionId }) =>
        sessionId === activeSessionId &&
        entry.schemaVersion === 3 &&
        entry.record.type === "runtime_event" &&
        entry.record.event.type === "tool_permission_decided" &&
        entry.record.event.requestId === requestId,
    )
  ) {
    return null;
  }
  const event = requested.entry.record.event;
  const runId = requested.entry.record.runId;
  const genesis = records.find(
    ({ entry, sessionId }) =>
      sessionId === activeSessionId &&
      entry.schemaVersion === 3 &&
      entry.record.type === "session_genesis",
  );
  const response = records.findLast(
    ({ entry, sessionId }) =>
      sessionId === activeSessionId &&
      entry.schemaVersion === 3 &&
      entry.record.type === "model_response_completed" &&
      entry.record.runId === runId,
  );
  if (
    genesis?.entry.schemaVersion !== 3 ||
    genesis.entry.record.type !== "session_genesis" ||
    response?.entry.schemaVersion !== 3 ||
    response.entry.record.type !== "model_response_completed"
  ) {
    return null;
  }
  const callIndex = response.entry.record.response.toolCalls.findIndex(
    (call) => call.id === event.callId && call.name === event.name,
  );
  const call = response.entry.record.response.toolCalls[callIndex];
  const intent = response.entry.record.response.toolIntents[callIndex];
  const reference = event.changePreviewRef;
  return reference !== undefined &&
    call !== undefined &&
    intent !== undefined &&
    reference.source.projectId === genesis.entry.record.projectId &&
    reference.source.sessionId === activeSessionId &&
    reference.source.runId === runId &&
    reference.source.callId === event.callId &&
    reference.source.toolName === event.name &&
    reference.source.argumentsDigest === intent.argumentsDigest &&
    reference.source.provenance === "prepared_tool_change"
    ? reference
    : null;
}

export function projectChangePreviewPage(input: {
  readonly name: "write_file" | "edit_file";
  readonly referenceByteCount: number;
  readonly decodedText: string;
  readonly decodedByteCount: number;
}): ToolPreviewDisplay {
  const bounded = boundedTextLines(
    input.decodedText,
    toolTextPreviewMaximumBytes,
    toolTextPreviewMaximumLines,
  );
  const omittedBytes =
    Math.max(0, input.referenceByteCount - input.decodedByteCount) + bounded.omittedBytes;
  const path = bounded.lines.find((line) => line.startsWith("+++ b/"))?.slice("+++ b/".length);
  if (input.name === "write_file") {
    const lines = bounded.lines
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line, index) => ({ number: index + 1, text: line.slice(1) }));
    return {
      kind: "write_text",
      language: path === undefined ? null : languageForPath(path),
      lines,
      omittedBytes,
    };
  }
  return {
    kind: "diff",
    language: path === undefined ? null : languageForPath(path),
    lines: bounded.lines.map((line) => {
      const kind = diffLineKind(line);
      return {
        kind,
        oldLineNumber: null,
        newLineNumber: null,
        text: kind === "addition" || kind === "deletion" ? line.slice(1) : line,
      };
    }),
    omittedBytes,
  };
}

function presentationChangePreviewRef(
  reference: ArtifactReference<ChangePreviewArtifactSource>,
): NonNullable<ToolCallDisplay["changePreviewRef"]> {
  return {
    id: reference.id,
    mediaType: reference.mediaType,
    byteCount: reference.byteCount,
    source: "change_preview",
  };
}

function toolKind(name: string): ToolCallDisplay["kind"] {
  if (name === "web_search" || name === "web_fetch" || name === "web_open" || name === "web_find") {
    return "web";
  }
  if (name === "read_file" || name === "search_repository") {
    return "read";
  }
  if (name === "run_shell") {
    return "shell";
  }
  if (name === "write_file" || name === "edit_file") {
    return "mutation";
  }
  return name.startsWith("mcp__") ? "mcp" : "unknown";
}

function isLiteralLoopbackProviderOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
      url.port !== ""
    );
  } catch {
    return false;
  }
}

function toolLabel(name: string): string {
  return name === "read_file"
    ? "read"
    : name === "search_repository"
      ? "search"
      : name === "run_shell"
        ? "shell"
        : name === "write_file"
          ? "write"
          : name === "edit_file"
            ? "edit"
            : name === "web_search"
              ? "web search"
              : name === "web_fetch"
                ? "web fetch"
                : name === "web_open"
                  ? "web open"
                  : name === "web_find"
                    ? "web find"
                    : name;
}

function safeToolSubject(
  subject: PermissionSubject | undefined,
  output: JsonValue | undefined,
): ToolCallDisplay["subject"] {
  if (subject?.type === "file" || subject?.type === "workspace_path") {
    return { type: "path", value: subject.path };
  }
  if (subject?.type === "command" || subject?.type === "plan_command") {
    return { type: "command", value: subject.command };
  }
  if (subject?.type === "web_request") {
    return {
      type: "generic",
      value:
        subject.operation === "fetch"
          ? `${subject.providerOrigin} · ${subject.url}`
          : `${subject.providerOrigin} · query ${JSON.stringify(subject.query)} · limit ${subject.limit}${subject.language === undefined ? "" : ` · language ${JSON.stringify(subject.language)}`}${subject.timeRange === undefined ? "" : ` · time range ${subject.timeRange}`}`,
    };
  }
  if (subject?.type === "managed_agent_web_request") {
    return {
      type: "generic",
      value: `${subject.agentId} (research.v1) · ${subject.providerOrigin} · ${subject.operation} ${JSON.stringify(subject.queryOrUrl)}`,
    };
  }
  if (subject?.type === "web_artifact") {
    return { type: "generic", value: subject.artifactId };
  }
  const outputRecord = jsonRecord(output);
  const outputPath = outputRecord?.path;
  if (typeof outputPath === "string") {
    return { type: "path", value: outputPath };
  }
  return subject === undefined ? null : { type: "generic", value: subject.type };
}

function toolResultSummary(name: string, output: JsonValue | undefined): string | null {
  const outputRecord = jsonRecord(output);
  const { matches, partial, resultCount, results, status, text } = outputRecord ?? {};
  if (name === "read_file" && typeof outputRecord?.content === "string") {
    return `${Buffer.byteLength(outputRecord.content, "utf8")} bytes${
      outputRecord.truncated === true ? " · output truncated" : ""
    }`;
  }
  if (name === "run_shell") {
    const termination = jsonRecord(outputRecord?.termination);
    const stdout = jsonRecord(outputRecord?.stdout);
    const stderr = jsonRecord(outputRecord?.stderr);
    if (
      termination?.type === "exited" &&
      typeof termination.exitCode === "number" &&
      typeof stdout?.totalBytes === "number" &&
      typeof stderr?.totalBytes === "number"
    ) {
      const streamSummaries = [
        ...(stdout.totalBytes > 0 || stderr.totalBytes === 0
          ? [`${stdout.totalBytes} stdout bytes`]
          : []),
        ...(stderr.totalBytes > 0 ? [`${stderr.totalBytes} stderr bytes`] : []),
      ];
      const outputTruncated =
        (typeof stdout.omittedBytes === "number" && stdout.omittedBytes > 0) ||
        (typeof stderr.omittedBytes === "number" && stderr.omittedBytes > 0);
      return `exit ${termination.exitCode} · ${streamSummaries.join(" · ")}${
        outputTruncated ? " · output truncated" : ""
      }`;
    }
  }
  if (name === "search_repository" && typeof resultCount === "number") {
    return `${resultCount} ${resultCount === 1 ? "result" : "results"}`;
  }
  if (name === "web_search" && Array.isArray(results)) {
    return `${results.length} Web ${results.length === 1 ? "source" : "sources"}${partial === true ? " · partial" : ""}`;
  }
  if (name === "web_fetch" && status === "redirect") {
    return "Cross-origin redirect · separate approval required";
  }
  if ((name === "web_fetch" || name === "web_open") && typeof text === "string") {
    return `${Buffer.byteLength(text, "utf8")} bytes${outputRecord?.truncated === true ? " · more available" : ""}`;
  }
  if (name === "web_find" && Array.isArray(matches)) {
    return `${matches.length} exact ${matches.length === 1 ? "match" : "matches"}${outputRecord?.truncated === true ? " · more available" : ""}`;
  }
  if (name.startsWith("mcp__")) {
    const content = outputRecord?.content;
    const outputTruncated =
      (Array.isArray(content) && content.some((block) => jsonRecord(block)?.truncated === true)) ||
      (typeof outputRecord?.omittedContentBlocks === "number" &&
        outputRecord.omittedContentBlocks > 0);
    return output === undefined ? null : `Completed${outputTruncated ? " · output truncated" : ""}`;
  }
  return output === undefined ? null : "Completed";
}

const toolTextPreviewMaximumBytes = 16 * 1024;
const toolTextPreviewMaximumLines = 200;
const toolShellStreamPreviewMaximumBytes = 8 * 1024;

function toolPreview(
  name: string,
  output: JsonValue | undefined,
  subject: ToolCallDisplay["subject"],
  changePreviewRef: ToolCallDisplay["changePreviewRef"] | undefined,
  changePreviewCache: ReadonlyMap<string, ToolPreviewDisplay | null>,
): ToolCallDisplay["preview"] {
  const outputRecord = jsonRecord(output);
  const { text: outputText } = outputRecord ?? {};
  if (name === "read_file" && typeof outputRecord?.content === "string") {
    const bounded = boundedTextLines(
      outputRecord.content,
      toolTextPreviewMaximumBytes,
      toolTextPreviewMaximumLines,
    );
    return {
      kind: "read_text",
      language: subject?.type === "path" ? languageForPath(subject.value) : null,
      lines: bounded.lines.map((text, index) => ({ number: index + 1, text })),
      omittedBytes: bounded.omittedBytes,
      sourceTruncated: outputRecord?.truncated === true,
    };
  }
  if ((name === "web_fetch" || name === "web_open") && typeof outputText === "string") {
    const bounded = boundedTextLines(
      outputText,
      toolTextPreviewMaximumBytes,
      toolTextPreviewMaximumLines,
    );
    return {
      kind: "read_text",
      language: null,
      lines: bounded.lines.map((text, index) => ({ number: index + 1, text })),
      omittedBytes: bounded.omittedBytes,
      sourceTruncated: outputRecord?.truncated === true,
    };
  }
  if (
    (name === "write_file" || name === "edit_file") &&
    changePreviewRef !== undefined &&
    changePreviewRef !== null
  ) {
    return changePreviewCache.get(changePreviewRef.id) ?? null;
  }
  if (name === "run_shell") {
    const termination = jsonRecord(outputRecord?.termination);
    const stdout = jsonRecord(outputRecord?.stdout);
    const stderr = jsonRecord(outputRecord?.stderr);
    const projectedTermination = shellTerminationPreview(termination);
    const projectedStdout = shellStreamPreview(stdout);
    const projectedStderr = shellStreamPreview(stderr);
    return projectedTermination === null || projectedStdout === null || projectedStderr === null
      ? null
      : {
          kind: "shell_output",
          termination: projectedTermination,
          stdout: projectedStdout,
          stderr: projectedStderr,
        };
  }
  return null;
}

function toolOutcome(tool: MutableToolDisplay): ToolCallDisplay["outcome"] {
  if (tool.failure?.code === "tool_effect_indeterminate") {
    return {
      status: "indeterminate",
      code: "tool_effect_indeterminate",
      reason: tool.failure.reason ?? null,
      message: tool.failure.message,
    };
  }
  if (tool.failure !== undefined) {
    return {
      status: "failed",
      code: tool.failure.code,
      message: tool.failure.message,
    };
  }
  if (tool.status === "completed") {
    return { status: "completed" };
  }
  if (tool.status === "denied") {
    return {
      status: "denied",
      code: "permission_denied",
      message: "Permission was denied for this tool call.",
    };
  }
  return null;
}

function diffLineKind(line: string): "meta" | "context" | "addition" | "deletion" {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
    return "meta";
  }
  if (line.startsWith("+")) {
    return "addition";
  }
  if (line.startsWith("-")) {
    return "deletion";
  }
  return "context";
}

function boundedTextLines(
  text: string,
  maximumBytes: number,
  maximumLines: number,
): { readonly lines: readonly string[]; readonly omittedBytes: number } {
  const sourceBytes = Buffer.byteLength(text, "utf8");
  const sourceLines = text.split("\n");
  if (sourceLines.at(-1) === "") {
    sourceLines.pop();
  }
  const lines: string[] = [];
  let consumedBytes = 0;
  for (const [index, line] of sourceLines.entries()) {
    if (lines.length >= maximumLines || consumedBytes >= maximumBytes) {
      break;
    }
    const lineBytes = Buffer.byteLength(line, "utf8");
    const newlineBytes = index < sourceLines.length - 1 || text.endsWith("\n") ? 1 : 0;
    if (consumedBytes + lineBytes + newlineBytes <= maximumBytes) {
      lines.push(line);
      consumedBytes += lineBytes + newlineBytes;
      continue;
    }
    const remainingBytes = maximumBytes - consumedBytes;
    const prefix = boundedUtf8Prefix(line, remainingBytes);
    if (prefix.byteCount > 0 || lines.length === 0) {
      lines.push(prefix.text);
      consumedBytes += prefix.byteCount;
    }
    break;
  }
  return { lines, omittedBytes: Math.max(0, sourceBytes - consumedBytes) };
}

function boundedUtf8Prefix(
  text: string,
  maximumBytes: number,
): { readonly text: string; readonly byteCount: number } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maximumBytes) {
    return { text, byteCount: bytes.byteLength };
  }
  let end = Math.max(0, maximumBytes);
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) {
    end -= 1;
  }
  return { text: bytes.subarray(0, end).toString("utf8"), byteCount: end };
}

function boundedUtf8Tail(
  text: string,
  maximumBytes: number,
): { readonly text: string; readonly byteCount: number } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maximumBytes) {
    return { text, byteCount: bytes.byteLength };
  }
  let start = bytes.byteLength - maximumBytes;
  while (start < bytes.byteLength && (bytes[start] ?? 0) >= 0x80 && (bytes[start] ?? 0) < 0xc0) {
    start += 1;
  }
  return {
    text: bytes.subarray(start).toString("utf8"),
    byteCount: bytes.byteLength - start,
  };
}

function shellStreamPreview(value: KnownJsonRecord | undefined): {
  readonly text: string;
  readonly totalBytes: number;
  readonly omittedBytes: number;
} | null {
  if (
    typeof value?.tail !== "string" ||
    typeof value.totalBytes !== "number" ||
    typeof value.omittedBytes !== "number"
  ) {
    return null;
  }
  const bounded = boundedUtf8Tail(value.tail, toolShellStreamPreviewMaximumBytes);
  const retainedBytes = Buffer.byteLength(value.tail, "utf8");
  return {
    text: bounded.text,
    totalBytes: value.totalBytes,
    omittedBytes: value.omittedBytes + retainedBytes - bounded.byteCount,
  };
}

function shellTerminationPreview(
  value: KnownJsonRecord | undefined,
): Extract<ToolCallDisplay["preview"], { readonly kind: "shell_output" }>["termination"] | null {
  if (value?.type === "exited" && typeof value.exitCode === "number") {
    return { type: "exited", exitCode: value.exitCode };
  }
  if (value?.type === "timed_out" || value?.type === "interrupted") {
    return { type: value.type };
  }
  return value?.type === "signalled" && typeof value.signal === "string"
    ? { type: "signalled", signal: value.signal }
    : null;
}

function languageForPath(path: string): string | null {
  const extension = /\.([^./]+)$/u.exec(path)?.[1]?.toLowerCase();
  const languages: Readonly<Record<string, string>> = {
    bash: "bash",
    c: "c",
    cc: "cpp",
    cpp: "cpp",
    css: "css",
    go: "go",
    h: "c",
    hpp: "cpp",
    html: "html",
    java: "java",
    js: "javascript",
    json: "json",
    jsx: "javascript",
    kt: "kotlin",
    kts: "kotlin",
    md: "markdown",
    py: "python",
    rb: "ruby",
    rs: "rust",
    sh: "bash",
    sql: "sql",
    ts: "typescript",
    tsx: "typescript",
    yaml: "yaml",
    yml: "yaml",
  };
  return extension === undefined ? "text" : (languages[extension] ?? "text");
}

function boundedDisplayText(value: string): string {
  return [...value.replaceAll(/\s+/gu, " ").trim()].slice(0, 240).join("");
}

function toolArtifacts(
  output: JsonValue | undefined,
): readonly ToolCallDisplay["artifacts"][number][] {
  const outputRecord = jsonRecord(output);
  const candidates = [
    jsonRecord(outputRecord?.artifact),
    jsonRecord(jsonRecord(outputRecord?.stdout)?.artifact),
    jsonRecord(jsonRecord(outputRecord?.stderr)?.artifact),
  ];
  return candidates.flatMap((candidate) => {
    const id = candidate?.id;
    const mediaType = candidate?.mediaType;
    const byteCount = candidate?.byteCount;
    return typeof id === "string" && typeof mediaType === "string" && typeof byteCount === "number"
      ? [{ id, mediaType, byteCount, source: "tool_output" as const }]
      : [];
  });
}

type KnownJsonRecord = Readonly<Record<string, JsonValue>> & {
  readonly path?: JsonValue;
  readonly content?: JsonValue;
  readonly termination?: JsonValue;
  readonly stdout?: JsonValue;
  readonly stderr?: JsonValue;
  readonly artifact?: JsonValue;
  readonly type?: JsonValue;
  readonly exitCode?: JsonValue;
  readonly signal?: JsonValue;
  readonly tail?: JsonValue;
  readonly totalBytes?: JsonValue;
  readonly omittedBytes?: JsonValue;
  readonly omittedContentBlocks?: JsonValue;
  readonly truncated?: JsonValue;
  readonly id?: JsonValue;
  readonly mediaType?: JsonValue;
  readonly byteCount?: JsonValue;
};

function jsonRecord(value: JsonValue | undefined): KnownJsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as KnownJsonRecord)
    : undefined;
}
