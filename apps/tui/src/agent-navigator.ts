import type {
  ArtifactChunk,
  ArtifactRange,
  ArtifactReference,
  AuthoritativePresentationSnapshot,
  ManagedAgentTranscriptPageResource,
  PresentationDisplayState,
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
import { reasoningFoldTitle } from "./reasoning-fold.js";
import { safeTerminalText } from "./safe-terminal-text.js";
import { type SearchableSelectItem, SearchableSelectList } from "./searchable-select-list.js";
import type { AdamTuiTheme } from "./theme.js";
import { ToolPreview } from "./tool-preview.js";

type ManagedAgents = AuthoritativePresentationSnapshot["managedAgents"];
type ManagedAgent = ManagedAgents["agents"][number];
type ManagedAgentActivity = NonNullable<PresentationDisplayState["managedAgentActivity"]>;

export class AgentNavigator implements Component {
  #activity: ManagedAgentActivity = [];
  #artifactGeneration = 0;
  #artifactView: { readonly artifact: ArtifactReference; readonly chunk: ArtifactChunk } | null =
    null;
  #managedAgents: ManagedAgents;
  readonly #maximumContentHeight: () => number;
  readonly #onCancel: (input: {
    readonly agentId: string;
    readonly expectedRevision: number;
  }) => void;
  readonly #onChange: () => void;
  readonly #onClose: () => void;
  readonly #onFollowUp:
    | ((input: { readonly agentId: string; readonly expectedRevision: number }) => void)
    | undefined;
  readonly #onMessage:
    | ((input: { readonly agentId: string; readonly expectedRevision: number }) => void)
    | undefined;
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
  readonly #onReply: (input: {
    readonly agentId: string;
    readonly expectedRevision: number;
    readonly attentionId: string;
  }) => void;
  readonly #onReadTranscript:
    | ((input: {
        readonly agentId: string;
        readonly attemptId: string;
        readonly expectedRevision: number;
        readonly expectedThroughSequence: number;
        readonly cursor: string | null;
      }) => Promise<ManagedAgentTranscriptPageResource>)
    | undefined;
  readonly #onRecovery:
    | ((input: { readonly agentId: string; readonly expectedRevision: number }) => void)
    | undefined;
  readonly #theme: AdamTuiTheme;
  #cancelConfirmation: string | null = null;
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
    readonly onCancel: (input: {
      readonly agentId: string;
      readonly expectedRevision: number;
    }) => void;
    readonly onChange: () => void;
    readonly onClose: () => void;
    readonly onFollowUp?: (input: {
      readonly agentId: string;
      readonly expectedRevision: number;
    }) => void;
    readonly onMessage?: (input: {
      readonly agentId: string;
      readonly expectedRevision: number;
    }) => void;
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
    readonly onRecovery?: (input: {
      readonly agentId: string;
      readonly expectedRevision: number;
    }) => void;
    readonly onReply: (input: {
      readonly agentId: string;
      readonly expectedRevision: number;
      readonly attentionId: string;
    }) => void;
    readonly theme: AdamTuiTheme;
  }) {
    this.#managedAgents = options.managedAgents;
    this.#maximumContentHeight = options.maximumContentHeight ?? (() => 22);
    this.#onCancel = options.onCancel;
    this.#onChange = options.onChange;
    this.#onClose = options.onClose;
    this.#onFollowUp = options.onFollowUp;
    this.#onMessage = options.onMessage;
    this.#onReadArtifact = options.onReadArtifact;
    this.#onReadTranscript = options.onReadTranscript;
    this.#onRecovery = options.onRecovery;
    this.#onReply = options.onReply;
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
      this.#cancelConfirmation = null;
      this.#detail = null;
      this.#onChange();
      return;
    }
    if (this.#detail !== null) {
      if (
        (isKeyRepeat(data) || isKeyRelease(data)) &&
        (["a", "m", "f", "r", "c"] as const).some((key) => matchesKey(data, key))
      ) {
        return;
      }
      if (!matchesKey(data, "c")) {
        this.#cancelConfirmation = null;
      }
      if (getKeybindings().matches(data, "tui.select.up")) {
        this.#transcriptFollowingTail = false;
        this.#transcriptScrollTop = Math.max(0, this.#transcriptScrollTop - 1);
        this.#onChange();
        return;
      }
      if (getKeybindings().matches(data, "tui.select.down")) {
        this.#transcriptScrollTop = Math.min(
          this.#transcriptMaximumScroll,
          this.#transcriptScrollTop + 1,
        );
        this.#transcriptFollowingTail = this.#transcriptScrollTop === this.#transcriptMaximumScroll;
        this.#onChange();
        return;
      }
      if (getKeybindings().matches(data, "tui.select.pageUp")) {
        if (this.#transcriptScrollTop === 0 && this.#transcript?.olderCursor !== null) {
          void this.#loadTranscript(this.#transcript?.olderCursor ?? null);
        } else {
          this.#transcriptFollowingTail = false;
          this.#transcriptScrollTop = Math.max(0, this.#transcriptScrollTop - 5);
          this.#onChange();
        }
        return;
      }
      if (getKeybindings().matches(data, "tui.select.pageDown")) {
        if (this.#artifactView !== null && this.#artifactView.chunk.nextRange !== null) {
          void this.#loadArtifact(this.#artifactView.artifact, this.#artifactView.chunk.nextRange);
          return;
        }
        this.#transcriptScrollTop = Math.min(
          this.#transcriptMaximumScroll,
          this.#transcriptScrollTop + 5,
        );
        this.#transcriptFollowingTail = this.#transcriptScrollTop === this.#transcriptMaximumScroll;
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
      if (
        matchesKey(data, "m") &&
        isActiveManagedAgent(this.#detail) &&
        this.#onMessage !== undefined
      ) {
        this.#onMessage({
          agentId: this.#detail.agentId,
          expectedRevision: this.#detail.revision,
        });
        return;
      }
      if (matchesKey(data, "f") && canFollowUp(this.#detail) && this.#onFollowUp !== undefined) {
        this.#onFollowUp({
          agentId: this.#detail.agentId,
          expectedRevision: this.#detail.revision,
        });
        return;
      }
      if (
        matchesKey(data, "r") &&
        this.#detail.status === "recovery_required" &&
        this.#onRecovery !== undefined
      ) {
        this.#onRecovery({
          agentId: this.#detail.agentId,
          expectedRevision: this.#detail.revision,
        });
        return;
      }
      if (matchesKey(data, "c") && isActiveManagedAgent(this.#detail)) {
        const confirmation = `${this.#detail.agentId}:${this.#detail.revision}`;
        if (this.#cancelConfirmation === confirmation) {
          this.#cancelConfirmation = null;
          this.#onCancel({
            agentId: this.#detail.agentId,
            expectedRevision: this.#detail.revision,
          });
        } else {
          this.#cancelConfirmation = confirmation;
          this.#onChange();
        }
        return;
      }
      if (
        matchesKey(data, "r") &&
        this.#detail.status === "waiting_for_parent" &&
        this.#detail.attention !== undefined
      ) {
        this.#onReply({
          agentId: this.#detail.agentId,
          expectedRevision: this.#detail.revision,
          attentionId: this.#detail.attention.attentionId,
        });
      }
      return;
    }
    this.#list.handleInput(data);
  }

  invalidate(): void {
    this.#list.invalidate();
  }

  setManagedAgents(managedAgents: ManagedAgents, activity: ManagedAgentActivity = []): void {
    const previousDetail = this.#detail;
    const detailAgentId = previousDetail?.agentId;
    this.#managedAgents = managedAgents;
    this.#activity = activity;
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
        this.#cancelConfirmation = null;
        void this.#loadTranscript(null);
      } else if (this.#detail !== null && transcriptChanged) {
        this.#artifactGeneration += 1;
        this.#artifactView = null;
        this.#cancelConfirmation = null;
        void this.#loadTranscript(null);
      }
      if (
        this.#detail === null ||
        this.#cancelConfirmation !== `${this.#detail.agentId}:${this.#detail.revision}`
      ) {
        this.#cancelConfirmation = null;
      }
    }
  }

  render(width: number): string[] {
    if (this.#detail !== null) {
      const detail = this.#detail;
      const maximumContentHeight = Math.max(8, Math.floor(this.#maximumContentHeight()));
      const hasArtifact = managedTranscriptArtifacts(this.#transcript).length > 0;
      const rosterLines =
        width < 80 || this.#managedAgents.counts.active === 0
          ? []
          : [
              this.#theme.toolTitle(
                `Agents · ${this.#managedAgents.counts.active} active · ${this.#managedAgents.counts.terminal} terminal`,
              ),
              ...new ManagedAgentRoster({ managedAgents: this.#managedAgents, theme: this.#theme })
                .render(width)
                .slice(0, 3),
            ];
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
        ...(isActiveManagedAgent(detail) && this.#onMessage !== undefined
          ? [
              this.#theme.muted(
                "m message at next safe boundary; delivery does not imply compliance",
              ),
            ]
          : []),
        ...(this.#cancelConfirmation === `${detail.agentId}:${detail.revision}`
          ? [this.#theme.statusWarning("Press c again to stop this exact child")]
          : []),
        ...(canFollowUp(detail) && this.#onFollowUp !== undefined
          ? [this.#theme.muted("f follow-up from exact terminal evidence")]
          : []),
        ...(detail.status === "recovery_required" && this.#onRecovery !== undefined
          ? [this.#theme.muted("r recover from exact durable evidence")]
          : []),
        ...(hasArtifact && this.#onReadArtifact !== undefined
          ? [this.#theme.muted("a read artifact")]
          : []),
        this.#theme.muted(
          isActiveManagedAgent(detail) && detail.status !== "waiting_for_parent"
            ? "↑↓ scroll · PgUp older · c cancel exact revision · Esc back · Ctrl+Q exit"
            : detail.status === "waiting_for_parent"
              ? "↑↓ scroll · PgUp older · r reply exact attention · c cancel exact revision · Esc back · Ctrl+Q exit"
              : "Terminal child · Esc back · Ctrl+Q exit",
        ),
      ];
      const fullHeaderLines = [
        this.#theme.toolTitle("Agent detail"),
        `${detail.profile} · ${detail.mode} · ${detail.status} · revision ${detail.revision} · ${detail.phase}${detail.activeTool === undefined ? "" : ` · ${detail.activeTool.name} ${detail.activeTool.status}`}`,
        `${safeTerminalText(detail.targetIdentity.targetId)} · ${safeTerminalText(detail.targetIdentity.modelId)} · ${safeTerminalText(detail.targetIdentity.route)}${detail.thinkingPolicy === undefined ? "" : ` · thinking ${safeTerminalText(detail.thinkingPolicy.effectiveLevelId)}`}`,
        `Context ${detail.context?.contextWindowTokens ?? "unknown"} capacity · ${managedContextOccupancy(detail)}`,
        detail.usage === undefined
          ? "Usage unavailable"
          : `Usage ${detail.usage.inputTokens} in + ${detail.usage.outputTokens} out · ${detail.usage.reasoningTokens} reasoning · ${detail.usage.providerCalls} calls`,
        detail.budget === undefined
          ? "Budget unavailable"
          : `Budget ${detail.budget.usedTokens}/${detail.budget.maximumCumulativeTokens} · ${detail.budget.remainingTokens} left`,
        `${detail.watchdog === undefined ? "Watchdog unavailable" : `Watchdog ${detail.watchdog.state} · ${detail.watchdog.maximumInactivityMilliseconds} ms`}${detail.attempts === undefined ? "" : ` · attempts ${detail.attempts.childAttempts}/${detail.attempts.maximumChildAttempts} child ${detail.attempts.parentAttempts}/${detail.attempts.maximumParentAttempts} parent`}`,
        `Agent ${safeTerminalText(detail.agentId)} · Attempt ${safeTerminalText(detail.attemptId)}`,
      ];
      const transcriptTitle = this.#theme.toolTitle(
        this.#artifactView === null ? "Transcript · read-only" : "Artifact · read-only",
      );
      const fullPrefixLines = [
        ...rosterLines,
        ...fullHeaderLines,
        ...allEvidenceLines.slice(0, 2),
        ...fullActionLines,
        "",
        transcriptTitle,
      ];
      const compactPrefixLines = [
        this.#theme.toolTitle("Agent detail"),
        `${detail.profile} · ${detail.status} · revision ${detail.revision} · ${detail.phase}`,
        `${safeTerminalText(detail.targetIdentity.modelId)} · ${detail.context?.contextWindowTokens ?? "unknown"} context · ${managedContextOccupancy(detail)}`,
        ...allEvidenceLines.slice(0, 1),
        this.#theme.muted(
          compactAgentActions(detail, this.#cancelConfirmation, {
            artifact: hasArtifact && this.#onReadArtifact !== undefined,
            followUp: this.#onFollowUp !== undefined,
            message: this.#onMessage !== undefined,
            recovery: this.#onRecovery !== undefined,
          }),
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
      this.#theme.toolTitle(
        `Agents · ${this.#managedAgents.counts.active} active · ${this.#managedAgents.counts.terminal} terminal`,
      ),
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
        this.#artifactView = { artifact, chunk };
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
    return [
      `${safeTerminalText(view.artifact.mediaType)} · bytes ${view.chunk.offset}-${view.chunk.offset + view.chunk.byteCount}/${view.chunk.totalByteCount}`,
      ...safeTerminalText(view.chunk.text).split("\n"),
      ...(view.chunk.nextRange === null ? [] : ["PageDown next artifact page"]),
    ]
      .slice(0, Math.max(1, maximumVisible))
      .map((line) => boundedLine(line, width));
  }

  #renderTranscriptLines(width: number, maximumVisible = 5): string[] {
    if (this.#transcriptNotice !== null && this.#transcript === null) {
      return [this.#transcriptNotice];
    }
    if (this.#transcript === null) {
      return ["Transcript is unavailable for this viewer."];
    }
    const liveLines = this.#activity
      .filter(
        (activity) =>
          activity.agentId === this.#detail?.agentId &&
          activity.attemptId === this.#detail.attemptId,
      )
      .flatMap(managedActivityLines);
    const lines = [
      ...this.#transcript.items.flatMap((item) => transcriptItemLines(item, width, this.#theme)),
      ...liveLines,
    ];
    const contentHeight = Math.max(1, maximumVisible);
    const markers = [
      ...(this.#transcript.olderCursor === null ? [] : ["Older transcript available"]),
      ...(liveLines.length === 0
        ? []
        : [this.#transcriptFollowingTail ? "following live tail" : "reading paused"]),
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

export class ManagedAgentRoster implements Component {
  #managedAgents: ManagedAgents;
  readonly #theme: AdamTuiTheme;

  constructor(options: { readonly managedAgents: ManagedAgents; readonly theme: AdamTuiTheme }) {
    this.#managedAgents = options.managedAgents;
    this.#theme = options.theme;
  }

  invalidate(): void {}

  setManagedAgents(managedAgents: ManagedAgents): void {
    this.#managedAgents = managedAgents;
  }

  render(width: number): string[] {
    const active = this.#managedAgents.agents.filter(isActiveManagedAgent);
    const visible = active.slice(0, 3);
    return visible.map((agent, index) => {
      const hidden = index === visible.length - 1 ? active.length - visible.length : 0;
      const tool = agent.activeTool === undefined ? "" : ` · ${agent.activeTool.name}`;
      const attention =
        agent.status === "waiting_for_parent" || agent.status === "permission_required"
          ? " · attention"
          : "";
      const overflow = hidden === 0 ? "" : ` · +${hidden} active`;
      return boundedLine(
        `${this.#theme.toolTitle(agent.profile)} · ${agent.status}${tool}${attention}${overflow}`,
        width,
      );
    });
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

function managedActivityLines(activity: ManagedAgentActivity[number]): string[] {
  if (activity.assistant !== undefined) {
    return safeTerminalText(activity.assistant.text)
      .split("\n")
      .map((line) => `Live assistant · ${line}`);
  }
  if (activity.reasoning !== undefined) {
    return [
      `Live reasoning · ${activity.reasoning.status} · ${activity.reasoning.hasContent ? "content undisclosed" : "waiting"}`,
    ];
  }
  if (activity.tool !== undefined) {
    return [`Live tool · ${safeTerminalText(activity.tool.name)} · ${activity.tool.status}`];
  }
  return [`Live child · ${activity.activity}`];
}

function isActiveManagedAgent(agent: ManagedAgent): boolean {
  return (
    agent.status === "running" ||
    agent.status === "permission_required" ||
    agent.status === "stalled" ||
    agent.status === "waiting_for_parent"
  );
}

function canFollowUp(agent: ManagedAgent): boolean {
  return agent.status === "completed" || agent.status === "failed" || agent.status === "cancelled";
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

function compactAgentActions(
  agent: ManagedAgent,
  confirmation: string | null,
  available: {
    readonly artifact: boolean;
    readonly followUp: boolean;
    readonly message: boolean;
    readonly recovery: boolean;
  },
): string {
  if (confirmation === `${agent.agentId}:${agent.revision}`) {
    return "c again cancel · Esc back";
  }
  if (isActiveManagedAgent(agent)) {
    return [
      ...(available.message ? ["m message"] : []),
      ...(agent.status === "waiting_for_parent" ? ["r reply"] : []),
      ...(available.artifact ? ["a artifact"] : []),
      "c twice cancel",
      "↑↓ scroll",
      "Esc back",
    ].join(" · ");
  }
  return [
    ...(canFollowUp(agent) && available.followUp ? ["f follow-up"] : []),
    ...(agent.status === "recovery_required" && available.recovery ? ["r recover"] : []),
    ...(available.artifact ? ["a artifact"] : []),
    "↑↓ scroll",
    "Esc back",
  ].join(" · ");
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
