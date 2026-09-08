import type {
  ArtifactChunk,
  ArtifactRange,
  ArtifactReference,
  AuthoritativePresentationSnapshot,
  ManagedAgentTranscriptPageResource,
  TranscriptItem,
} from "@adam-agent/presentation";
import {
  type Component,
  getKeybindings,
  isKeyRelease,
  isKeyRepeat,
  Markdown,
  matchesKey,
  truncateToWidth,
} from "@earendil-works/pi-tui";

import { artifactPageRange } from "./artifact-navigator.js";
import { focusedWheelDirection } from "./focused-wheel-input.js";
import { reasoningFoldTitle } from "./reasoning-fold.js";
import { safeTerminalText } from "./safe-terminal-text.js";
import { type SearchableSelectItem, SearchableSelectList } from "./searchable-select-list.js";
import type { AdamTuiTheme } from "./theme.js";
import { ToolPreview } from "./tool-preview.js";

type ManagedAgents = AuthoritativePresentationSnapshot["managedAgents"];
type ManagedAgent = ManagedAgents["agents"][number];

export class LegacyAgentHistory implements Component {
  #artifactGeneration = 0;
  #artifactView: {
    readonly artifact: ArtifactReference;
    readonly chunk: ArtifactChunk;
    scrollTop: number;
    maximumScroll: number;
  } | null = null;
  #managedAgents: ManagedAgents;
  readonly #maximumContentHeight: () => number;
  readonly #onChange: () => void;
  readonly #onClose: () => void;
  readonly #onReadArtifact:
    | ((input: {
        readonly agentId: string;
        readonly attemptId: string;
        readonly expectedRevision: number;
        readonly expectedThroughSequence: number;
        readonly artifact: ArtifactReference;
        readonly range: ArtifactRange;
      }) => Promise<ArtifactChunk>)
    | undefined;
  readonly #onReadTranscript:
    | ((input: {
        readonly agentId: string;
        readonly attemptId: string;
        readonly expectedRevision: number;
        readonly expectedThroughSequence: number;
        readonly cursor: string | null;
      }) => Promise<ManagedAgentTranscriptPageResource>)
    | undefined;
  readonly #theme: AdamTuiTheme;
  #detail: ManagedAgent | null = null;
  readonly #list: SearchableSelectList;
  #transcript: ManagedAgentTranscriptPageResource | null = null;
  #transcriptGeneration = 0;
  #transcriptNotice: string | null = null;
  #transcriptScrollTop = 0;
  #transcriptMaximumScroll = 0;
  #transcriptFollowingTail = true;

  constructor(options: {
    readonly managedAgents: ManagedAgents;
    readonly maximumContentHeight?: () => number;
    readonly onChange: () => void;
    readonly onClose: () => void;
    readonly onReadArtifact?: (input: {
      readonly agentId: string;
      readonly attemptId: string;
      readonly expectedRevision: number;
      readonly expectedThroughSequence: number;
      readonly artifact: ArtifactReference;
      readonly range: ArtifactRange;
    }) => Promise<ArtifactChunk>;
    readonly onReadTranscript?: (input: {
      readonly agentId: string;
      readonly attemptId: string;
      readonly expectedRevision: number;
      readonly expectedThroughSequence: number;
      readonly cursor: string | null;
    }) => Promise<ManagedAgentTranscriptPageResource>;
    readonly theme: AdamTuiTheme;
  }) {
    this.#managedAgents = options.managedAgents;
    this.#maximumContentHeight = options.maximumContentHeight ?? (() => 22);
    this.#onChange = options.onChange;
    this.#onClose = options.onClose;
    this.#onReadArtifact = options.onReadArtifact;
    this.#onReadTranscript = options.onReadTranscript;
    this.#theme = options.theme;
    const items: SearchableSelectItem[] = options.managedAgents.agents.map((agent) => ({
      item: {
        value: agent.agentId,
        label: safeTerminalText(agent.agentId),
        description: `${agent.profile} · ${agent.status} · revision ${agent.revision}`,
      },
      searchText: `${agent.agentId} ${agent.attemptId} ${agent.profile} ${agent.status}`,
    }));
    this.#list = new SearchableSelectList({
      items,
      maxVisible: 8,
      onCancel: this.#onClose,
      onSelect: (selected) => {
        this.#detail =
          this.#managedAgents.agents.find((agent) => agent.agentId === selected.value) ?? null;
        this.#artifactGeneration += 1;
        this.#artifactView = null;
        this.#transcript = null;
        this.#transcriptScrollTop = 0;
        this.#transcriptFollowingTail = true;
        void this.#loadTranscript(null);
        this.#onChange();
      },
      theme: options.theme.editor.selectList,
    });
  }

  handleInput(data: string): void {
    const wheel = focusedWheelDirection(data);
    if (wheel !== null) {
      if (this.#detail === null) {
        this.#list.handleInput(wheel < 0 ? "\u001b[A" : "\u001b[B");
      } else {
        this.#scrollViewport(wheel * 3);
      }
      this.#onChange();
      return;
    }
    if (this.#artifactView !== null && getKeybindings().matches(data, "tui.select.cancel")) {
      this.#artifactGeneration += 1;
      this.#artifactView = null;
      this.#onChange();
      return;
    }
    if (this.#detail !== null && getKeybindings().matches(data, "tui.select.cancel")) {
      this.#transcriptGeneration += 1;
      this.#artifactGeneration += 1;
      this.#artifactView = null;
      this.#detail = null;
      this.#onChange();
      return;
    }
    if (this.#detail !== null) {
      if ((isKeyRepeat(data) || isKeyRelease(data)) && matchesKey(data, "a")) {
        return;
      }
      if (getKeybindings().matches(data, "tui.select.up")) {
        this.#scrollViewport(-1);
        this.#onChange();
        return;
      }
      if (getKeybindings().matches(data, "tui.select.down")) {
        this.#scrollViewport(1);
        this.#onChange();
        return;
      }
      if (getKeybindings().matches(data, "tui.select.pageUp")) {
        if (
          this.#artifactView === null &&
          this.#transcriptScrollTop === 0 &&
          this.#transcript?.olderCursor !== null
        ) {
          void this.#loadTranscript(this.#transcript?.olderCursor ?? null);
        } else {
          this.#scrollViewport(-5);
          this.#onChange();
        }
        return;
      }
      if (getKeybindings().matches(data, "tui.select.pageDown")) {
        if (this.#artifactView !== null && this.#artifactView.chunk.nextRange !== null) {
          void this.#loadArtifact(this.#artifactView.artifact, this.#artifactView.chunk.nextRange);
          return;
        }
        this.#scrollViewport(5);
        this.#onChange();
        return;
      }
      if (matchesKey(data, "a") && this.#onReadArtifact !== undefined) {
        const artifact = managedTranscriptArtifacts(this.#transcript).at(-1);
        if (artifact !== undefined) {
          void this.#loadArtifact(artifact, artifactPageRange(0));
        }
        return;
      }
      return;
    }
    this.#list.handleInput(data);
  }

  invalidate(): void {
    this.#list.invalidate();
  }

  setManagedAgents(managedAgents: ManagedAgents): void {
    const previousDetail = this.#detail;
    const detailAgentId = previousDetail?.agentId;
    this.#managedAgents = managedAgents;
    this.#list.setItems(agentSelectItems(managedAgents));
    if (detailAgentId !== undefined) {
      this.#detail = managedAgents.agents.find((agent) => agent.agentId === detailAgentId) ?? null;
      const attemptChanged = this.#detail?.attemptId !== previousDetail?.attemptId;
      const transcriptChanged =
        this.#detail?.transcript.throughSequence !== previousDetail?.transcript.throughSequence;
      if (this.#detail !== null && attemptChanged) {
        this.#transcriptGeneration += 1;
        this.#artifactGeneration += 1;
        this.#artifactView = null;
        this.#transcript = null;
        this.#transcriptNotice = null;
        this.#transcriptScrollTop = 0;
        this.#transcriptFollowingTail = true;
        void this.#loadTranscript(null);
      } else if (this.#detail !== null && transcriptChanged) {
        this.#artifactGeneration += 1;
        this.#artifactView = null;
        void this.#loadTranscript(null);
      }
    }
  }

  render(width: number): string[] {
    if (this.#detail !== null) {
      const detail = this.#detail;
      const maximumContentHeight = Math.max(8, Math.floor(this.#maximumContentHeight()));
      const hasArtifact = managedTranscriptArtifacts(this.#transcript).length > 0;
      const allEvidenceLines = [
        ...(detail.attention === undefined
          ? []
          : [
              `${detail.attention.status === "waiting" ? "Parent input requested" : "Parent input orphaned"} · ${safeTerminalText(detail.attention.question)}`,
            ]),
        ...(detail.error === undefined
          ? []
          : [`${safeTerminalText(detail.error.code)} · ${safeTerminalText(detail.error.message)}`]),
        ...managedResultLines(detail),
        ...(detail.reports ?? [])
          .slice(-2)
          .map(
            (report) =>
              `${report.kind} r${report.revision} · ${safeTerminalText(report.message)}${report.messageTruncated ? ` · ${report.messageByteCount} bytes total` : ""}`,
          ),
      ];
      const fullActionLines = [
        this.#theme.muted("Read-only history · Esc back"),
        ...(hasArtifact && this.#onReadArtifact !== undefined
          ? [this.#theme.muted("a read artifact")]
          : []),
        this.#theme.muted("↑↓ scroll · PgUp older · Ctrl+Q exit"),
      ];
      const fullHeaderLines = [
        this.#theme.toolTitle("Agent history detail"),
        `${detail.profile} · ${detail.mode} · ${detail.status} · revision ${detail.revision} · ${detail.phase}${detail.activeTool === undefined ? "" : ` · ${detail.activeTool.name} ${detail.activeTool.status}`}`,
        `${safeTerminalText(detail.targetIdentity.targetId)} · ${safeTerminalText(detail.targetIdentity.modelId)} · ${safeTerminalText(detail.targetIdentity.route)}${detail.thinkingPolicy === undefined ? "" : ` · thinking ${safeTerminalText(detail.thinkingPolicy.effectiveLevelId)}`}`,
        `Context ${detail.context?.contextWindowTokens ?? "unknown"} capacity · ${managedContextOccupancy(detail)}`,
        detail.usage === undefined
          ? "Usage unavailable"
          : `Usage ${detail.usage.inputTokens} in + ${detail.usage.outputTokens} out · ${detail.usage.reasoningTokens} reasoning · ${detail.usage.providerCalls} calls`,
        detail.taskBudget !== undefined
          ? detail.taskBudget.policy.mode === "unbudgeted"
            ? `No cumulative budget · ${detail.taskBudget.usage.knownUsed} used · ${detail.taskBudget.usage.unknownReserved} unknown reserved`
            : `Task budget ${detail.taskBudget.usage.knownUsed}/${detail.taskBudget.usage.ceiling} · ${detail.taskBudget.usage.available} available · ${detail.taskBudget.usage.unknownReserved} unknown reserved`
          : detail.budget === undefined
            ? "Budget unavailable"
            : `Budget ${detail.budget.usedTokens}/${detail.budget.maximumCumulativeTokens} · ${detail.budget.remainingTokens} left`,
        ...((detail.taskBudget?.usage.overrun ?? 0) > 0
          ? [
              `Provider usage exceeded request estimates by ${detail.taskBudget?.usage.overrun} tokens.`,
            ]
          : []),
        `${detail.watchdog === undefined ? "Watchdog unavailable" : `Watchdog ${detail.watchdog.state} · ${detail.watchdog.maximumInactivityMilliseconds} ms`}${detail.attempts === undefined ? "" : ` · attempts ${detail.attempts.childAttempts}/${detail.attempts.maximumChildAttempts} child ${detail.attempts.parentAttempts}/${detail.attempts.maximumParentAttempts} parent`}`,
        `Agent ${safeTerminalText(detail.agentId)} · Attempt ${safeTerminalText(detail.attemptId)}`,
      ];
      const transcriptTitle = this.#theme.toolTitle(
        this.#artifactView === null ? "Transcript · read-only" : "Artifact · read-only",
      );
      const fullPrefixLines = [
        ...fullHeaderLines,
        ...allEvidenceLines.slice(0, 2),
        ...fullActionLines,
        "",
        transcriptTitle,
      ];
      const compactPrefixLines = [
        this.#theme.toolTitle("Agent history detail"),
        `${detail.profile} · ${detail.status} · revision ${detail.revision} · ${detail.phase}`,
        `${safeTerminalText(detail.targetIdentity.modelId)} · ${detail.context?.contextWindowTokens ?? "unknown"} context · ${managedContextOccupancy(detail)}`,
        ...allEvidenceLines.slice(0, 1),
        this.#theme.muted(
          `Read-only history${hasArtifact && this.#onReadArtifact !== undefined ? " · a artifact" : ""} · Esc back`,
        ),
        "",
        transcriptTitle,
      ];
      const prefixLines =
        fullPrefixLines.length + 1 <= maximumContentHeight ? fullPrefixLines : compactPrefixLines;
      const transcriptHeight = Math.max(1, maximumContentHeight - prefixLines.length);
      return [
        ...prefixLines,
        ...(this.#artifactView === null
          ? this.#renderTranscriptLines(width, transcriptHeight)
          : this.#renderArtifactLines(width, transcriptHeight)),
      ].map((line) => boundedLine(line, width));
    }
    const maximumContentHeight = Math.max(8, Math.floor(this.#maximumContentHeight()));
    const listHeight = Math.max(1, maximumContentHeight - 2);
    this.#list.setMaximumVisible(Math.min(8, Math.max(1, listHeight - 3)));
    return [
      this.#theme.toolTitle(`Agent history · ${this.#managedAgents.agents.length} records`),
      this.#theme.muted("type search · Enter detail · Esc close · Ctrl+Q exit"),
      ...this.#list.render(width, listHeight),
    ]
      .slice(0, maximumContentHeight)
      .map((line) => boundedLine(line, width));
  }

  async #loadTranscript(cursor: string | null): Promise<void> {
    const detail = this.#detail;
    if (detail === null || this.#onReadTranscript === undefined) {
      return;
    }
    const generation = ++this.#transcriptGeneration;
    this.#transcriptNotice = cursor === null ? "Loading transcript…" : "Loading older transcript…";
    this.#onChange();
    try {
      const page = await this.#onReadTranscript({
        agentId: detail.agentId,
        attemptId: detail.attemptId,
        expectedRevision: detail.revision,
        expectedThroughSequence: detail.transcript.throughSequence,
        cursor,
      });
      if (
        generation !== this.#transcriptGeneration ||
        this.#detail?.agentId !== page.agentId ||
        this.#detail.attemptId !== page.attemptId
      ) {
        return;
      }
      this.#transcript =
        cursor === null || this.#transcript === null
          ? cursor === null && this.#transcript !== null && !this.#transcriptFollowingTail
            ? {
                ...page,
                items: mergeTranscriptItems(this.#transcript.items, page.items),
                olderCursor: page.olderCursor,
              }
            : page
          : { ...page, items: mergeTranscriptItems(page.items, this.#transcript.items) };
      this.#transcriptNotice = null;
      if (this.#transcriptFollowingTail) {
        this.#transcriptScrollTop = Number.POSITIVE_INFINITY;
      }
    } catch (error) {
      if (generation === this.#transcriptGeneration) {
        this.#transcriptNotice =
          error instanceof Error ? safeTerminalText(error.message) : "Transcript unavailable.";
      }
    }
    this.#onChange();
  }

  async #loadArtifact(artifact: ArtifactReference, range: ArtifactRange): Promise<void> {
    if (this.#onReadArtifact === undefined) {
      return;
    }
    const detail = this.#detail;
    if (detail === null) {
      return;
    }
    const generation = ++this.#artifactGeneration;
    this.#transcriptNotice =
      range.offset === 0 ? "Loading artifact…" : "Loading next artifact page…";
    this.#onChange();
    try {
      const chunk = await this.#onReadArtifact({
        agentId: detail.agentId,
        attemptId: detail.attemptId,
        expectedRevision: detail.revision,
        expectedThroughSequence: detail.transcript.throughSequence,
        artifact,
        range,
      });
      const stale =
        generation !== this.#artifactGeneration ||
        this.#detail?.agentId !== detail.agentId ||
        this.#detail.attemptId !== detail.attemptId ||
        this.#detail.revision !== detail.revision ||
        this.#detail.transcript.throughSequence !== detail.transcript.throughSequence;
      if (!stale) {
        this.#artifactView = { artifact, chunk, scrollTop: 0, maximumScroll: 0 };
        this.#transcriptNotice = null;
      }
    } catch (error) {
      if (generation === this.#artifactGeneration) {
        this.#transcriptNotice =
          error instanceof Error ? safeTerminalText(error.message) : "Artifact unavailable.";
      }
    }
    this.#onChange();
  }

  #renderArtifactLines(width: number, maximumVisible: number): string[] {
    const view = this.#artifactView;
    if (view === null) {
      return [];
    }
    const lines = [
      `${safeTerminalText(view.artifact.mediaType)} · bytes ${view.chunk.offset}-${view.chunk.offset + view.chunk.byteCount}/${view.chunk.totalByteCount}`,
      ...safeTerminalText(view.chunk.text).split("\n"),
      ...(view.chunk.nextRange === null ? [] : ["PageDown next artifact page"]),
    ];
    const height = Math.max(1, maximumVisible);
    view.maximumScroll = Math.max(0, lines.length - height);
    view.scrollTop = Math.min(view.scrollTop, view.maximumScroll);
    return lines
      .slice(view.scrollTop, view.scrollTop + height)
      .map((line) => boundedLine(line, width));
  }

  #scrollViewport(delta: number): void {
    if (this.#artifactView !== null) {
      const view = this.#artifactView;
      view.scrollTop = Math.max(0, Math.min(view.maximumScroll, view.scrollTop + delta));
      return;
    }
    this.#transcriptScrollTop = Math.max(
      0,
      Math.min(this.#transcriptMaximumScroll, this.#transcriptScrollTop + delta),
    );
    this.#transcriptFollowingTail =
      delta > 0 && this.#transcriptScrollTop === this.#transcriptMaximumScroll;
  }

  #renderTranscriptLines(width: number, maximumVisible = 5): string[] {
    if (this.#transcriptNotice !== null && this.#transcript === null) {
      return [this.#transcriptNotice];
    }
    if (this.#transcript === null) {
      return ["Transcript is unavailable for this viewer."];
    }
    const lines = this.#transcript.items.flatMap((item) =>
      transcriptItemLines(item, width, this.#theme),
    );
    const contentHeight = Math.max(1, maximumVisible);
    const markers = [
      ...(this.#transcript.olderCursor === null ? [] : ["Older transcript available"]),
      ...(this.#transcriptFollowingTail ? [] : ["reading paused"]),
      ...(this.#transcriptNotice === null ? [] : [this.#transcriptNotice]),
    ];
    const visibleHeight = Math.max(1, contentHeight - markers.length);
    this.#transcriptMaximumScroll = Math.max(0, lines.length - visibleHeight);
    if (this.#transcriptFollowingTail || !Number.isFinite(this.#transcriptScrollTop)) {
      this.#transcriptScrollTop = this.#transcriptMaximumScroll;
    } else {
      this.#transcriptScrollTop = Math.min(
        this.#transcriptMaximumScroll,
        this.#transcriptScrollTop,
      );
    }
    const visible = lines.slice(
      this.#transcriptScrollTop,
      this.#transcriptScrollTop + visibleHeight,
    );
    return [
      ...(visible.length === 0 ? ["No retained child transcript items."] : visible),
      ...markers,
    ]
      .slice(0, contentHeight)
      .map((line) => boundedLine(line, width));
  }
}

function agentSelectItems(managedAgents: ManagedAgents): SearchableSelectItem[] {
  return managedAgents.agents.map((agent) => ({
    item: {
      value: agent.agentId,
      label: safeTerminalText(agent.agentId),
      description: `${agent.profile} · ${agent.status} · revision ${agent.revision}`,
    },
    searchText: `${agent.agentId} ${agent.attemptId} ${agent.profile} ${agent.status}`,
  }));
}

function transcriptItemLines(item: TranscriptItem, width: number, theme: AdamTuiTheme): string[] {
  if (item.type === "assistant_message") {
    if (item.text !== null) {
      return new Markdown(safeTerminalText(item.text), 0, 0, theme.markdown).render(width);
    }
    return item.artifact === null
      ? ["Assistant · retained content unavailable"]
      : [`Assistant artifact · ${item.artifact.mediaType} · ${item.artifact.byteCount} bytes`];
  }
  if (item.type === "reasoning_block") {
    return [
      reasoningFoldTitle({
        expanded: false,
        interactive: false,
        provider: item.provider,
        status: item.status,
        theme,
      }),
    ];
  }
  if (item.type === "tool_call") {
    return [
      `Tool · ${safeTerminalText(item.label)} · ${item.status}${item.resultSummary === null ? "" : ` · ${safeTerminalText(item.resultSummary)}`}`,
      ...(item.preview === null ? [] : new ToolPreview(item.preview, false, theme).render(width)),
      ...item.artifacts.map(
        (artifact) => `Artifact · ${artifact.mediaType} · ${artifact.byteCount} bytes`,
      ),
    ];
  }
  if (item.type === "session_notice") {
    return [
      item.status === "failed"
        ? `Session · ${safeTerminalText(item.code)} · ${safeTerminalText(item.message)}`
        : `Session · ${item.status} · ${item.reason}`,
    ];
  }
  if (item.type === "compaction_marker") {
    return [`Context compacted · through ${item.sourceThrough}`];
  }
  if (item.type === "user_message") {
    return [`User · ${safeTerminalText(item.text)}`];
  }
  if (item.type === "plan_submission") {
    return [`Plan · ${item.status} · revision ${item.submission.revision}`];
  }
  return [`Operation · ${safeTerminalText(item.operationId)}`];
}

function mergeTranscriptItems(
  previous: readonly TranscriptItem[],
  next: readonly TranscriptItem[],
): readonly TranscriptItem[] {
  const items = new Map(previous.map((item) => [item.id, item]));
  for (const item of next) {
    items.set(item.id, item);
  }
  return [...items.values()].sort(
    (left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id),
  );
}

function managedResultLines(agent: ManagedAgent): string[] {
  if (agent.result === undefined) {
    return [];
  }
  if ("artifact" in agent.result) {
    return [
      `Result artifact ${safeTerminalText(agent.result.artifact.id)} · ${agent.result.artifact.byteCount} bytes`,
    ];
  }
  const lines = safeTerminalText(agent.result.text).split("\n");
  return [
    ...lines.slice(0, 2).map((line) => `Result · ${line}`),
    ...(lines.length > 2 ? [`Result · +${lines.length - 2} lines hidden`] : []),
  ];
}

function managedContextOccupancy(agent: ManagedAgent): string {
  const occupancy = agent.context?.occupancy;
  if (occupancy === undefined) {
    return "occupancy not reported";
  }
  return occupancy.source === "unknown"
    ? "occupancy unknown"
    : `occupancy ${occupancy.tokens} · ${occupancy.source}`;
}

function managedTranscriptArtifacts(
  transcript: ManagedAgentTranscriptPageResource | null,
): readonly ArtifactReference[] {
  return (
    transcript?.items.flatMap((item) => {
      if (item.type === "assistant_message" || item.type === "reasoning_block") {
        return item.artifact === null ? [] : [item.artifact];
      }
      if (item.type === "tool_call") {
        return [
          ...item.artifacts,
          ...(item.changePreviewRef === null ? [] : [item.changePreviewRef]),
        ];
      }
      return [];
    }) ?? []
  );
}

function boundedLine(line: string, width: number): string {
  const bounded = truncateToWidth(line, Math.max(1, width), "");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip formatter-added ANSI resets only from an originally plain NO_COLOR line.
  return line.includes("\u001b[") ? bounded : bounded.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");
}
