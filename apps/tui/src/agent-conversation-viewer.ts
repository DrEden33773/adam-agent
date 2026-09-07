/**
 * Conversation focus and keys adapted from tintinweb/pi-subagents
 * src/ui/conversation-viewer.ts and src/ui/viewer-keys.ts
 * at 4f572eaa04c09d3dbc16e4a5f13a16b295e84e14 (MIT). See THIRD_PARTY_NOTICES.md.
 * The independent editor never transfers input to the Main editor.
 */
import { randomUUID } from "node:crypto";
import type {
  AgentExportField,
  ArtifactChunk,
  ArtifactRange,
  ArtifactReference,
  CommandReceipt,
  ManagedAgentExport,
  ManagedAgentTranscriptPageResource,
  ManagedComposerDraft,
  ManagedControlCommand,
  ManagedControlThread,
  ManagedWorkspaceSnapshot,
  PresentationDisplayState,
  TranscriptItem,
} from "@adam-agent/presentation";
import {
  agentExportFields,
  nextAgentViewerMode,
  presentationArtifactPageMaximumBytes,
} from "@adam-agent/presentation";
import {
  type Component,
  getKeybindings,
  Input,
  isKeyRelease,
  isKeyRepeat,
  Markdown,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { agentElapsedLabel } from "./agent-widget.js";
import { safeTerminalText } from "./safe-terminal-text.js";
import type { AdamTuiTheme } from "./theme.js";
import { ToolPreview } from "./tool-preview.js";

const viewerKeys = {
  up: (data: string) => getKeybindings().matches(data, "tui.select.up") || matchesKey(data, "k"),
  down: (data: string) =>
    getKeybindings().matches(data, "tui.select.down") || matchesKey(data, "j"),
  pageUp: (data: string) =>
    getKeybindings().matches(data, "tui.select.pageUp") || matchesKey(data, "shift+up"),
  pageDown: (data: string) =>
    getKeybindings().matches(data, "tui.select.pageDown") || matchesKey(data, "shift+down"),
};

type ConversationPage = {
  readonly items: readonly TranscriptItem[];
  readonly liveText: string | undefined;
  readonly liveOmittedBytes: number;
  readonly cursor: string | null;
  readonly olderCursor: string | null;
};

export type AgentConversationResource =
  | { readonly kind: "input"; readonly inputId: string; readonly label: string }
  | { readonly kind: "reasoning" | "tool"; readonly itemId: string; readonly label: string }
  | { readonly kind: "artifact"; readonly artifact: ArtifactReference; readonly label: string };

type ResourceView = {
  readonly thread: ManagedControlThread;
  readonly entries: readonly AgentConversationResource[];
  selected: number;
  visible: ReadonlySet<number>;
  page: ArtifactChunk | undefined;
  previousOffsets: number[];
  scroll: number;
  maximumScroll: number;
  pending: boolean;
  generation: number;
  notice: string;
  restoreArmed?: boolean;
  inputOnly?: boolean;
};

type ExportView = {
  readonly thread: ManagedControlThread;
  readonly completion: ManagedWorkspaceSnapshot["completions"][number];
  readonly fields: Set<AgentExportField>;
  selected: number;
  visible: ReadonlySet<number>;
  phase: "fields" | "confirm" | "pending" | "ready";
  confirmRendered: boolean;
  result: ManagedAgentExport | undefined;
  notice: string;
};

export class AgentConversationViewer implements Component {
  #thread: ManagedControlThread;
  #completion: ManagedWorkspaceSnapshot["completions"][number] | undefined;
  readonly #seenAttempts = new Set<string>();
  #suppressTarget: ManagedWorkspaceSnapshot["completions"][number] | undefined;
  #suppressPending = false;
  #exports: readonly ManagedAgentExport[] = [];
  #exportView: ExportView | undefined;
  readonly #composer = new Input();
  #composing = false;
  #focused = false;
  #activity: NonNullable<PresentationDisplayState["managedAgentActivity"]>[number] | undefined;
  #liveText: string | undefined;
  #liveOmittedBytes = 0;
  #items: readonly TranscriptItem[] = [];
  #olderCursor: string | null = null;
  #currentCursor: string | null = null;
  #manualPage: ConversationPage | undefined;
  #newerCursors: (string | null)[] = [];
  #pageReadPending = false;
  #pageGeneration = 0;
  #readKey = "";
  #readGeneration = 0;
  #closed = false;
  #details = false;
  #detailScroll = 0;
  #detailMaximumScroll = 0;
  #notice = "";
  #scrollOffset = 0;
  #followTail = true;
  #maximumScroll = 0;
  #bodyHeight = 1;
  #composeTarget:
    | Pick<ManagedComposerDraft, "parentSessionId" | "threadId" | "expectedTurnId" | "attentionId">
    | undefined;
  #retargetPending = false;
  #mode: "cooperative" | "interrupt" | "new_turn" | "reply" = "cooperative";
  #sending = false;
  #inputNotice = "";
  #lastInputId: string | undefined;
  #submission:
    | { readonly id: string; readonly text: string; readonly mode: string; readonly turnId: string }
    | undefined;
  #renderMode: "raw" | "assistant" | "full" = "assistant";
  readonly #markdown = new Map<
    string,
    { readonly component: Markdown; text: string; failed: boolean }
  >();
  #resources: ResourceView | undefined;
  #cancelTarget:
    | {
        readonly parentSessionId: string;
        readonly threadId: string;
        readonly expectedTurnId: string;
      }
    | undefined;
  #cancelling = false;
  constructor(
    private readonly options: {
      readonly thread: ManagedControlThread;
      readonly completion?: ManagedWorkspaceSnapshot["completions"][number] | undefined;
      readonly exports?: readonly ManagedAgentExport[] | undefined;
      readonly onExport: (
        thread: ManagedControlThread,
        completion: ManagedWorkspaceSnapshot["completions"][number],
        fields: readonly AgentExportField[],
      ) => Promise<CommandReceipt>;
      readonly onSeen: (
        completion: ManagedWorkspaceSnapshot["completions"][number],
      ) => Promise<CommandReceipt>;
      readonly onSuppress: (
        completion: ManagedWorkspaceSnapshot["completions"][number],
      ) => Promise<CommandReceipt>;
      readonly renderMode?: "raw" | "assistant" | "full";
      readonly onRenderMode?: (mode: "raw" | "assistant" | "full") => Promise<CommandReceipt>;
      readonly drafts: Map<string, ManagedComposerDraft>;
      readonly theme: AdamTuiTheme;
      readonly activity?:
        | NonNullable<PresentationDisplayState["managedAgentActivity"]>[number]
        | undefined;
      readonly maximumLines: () => number;
      readonly onRead: (
        thread: ManagedControlThread,
        cursor: string | null,
      ) => Promise<ManagedAgentTranscriptPageResource>;
      readonly onSend: (command: ManagedControlCommand) => Promise<CommandReceipt>;
      readonly onSaveDraft: (draft: ManagedComposerDraft) => Promise<void>;
      readonly onClearDraft: (draft: ManagedComposerDraft) => Promise<boolean>;
      readonly onReadResource: (
        thread: ManagedControlThread,
        resource: AgentConversationResource,
        range: ArtifactRange,
      ) => Promise<ArtifactChunk>;
      readonly onChange: () => void;
      readonly onClose: () => void;
    },
  ) {
    this.#thread = options.thread;
    this.#completion = options.completion;
    this.#exports = options.exports ?? [];
    this.#renderMode = options.renderMode ?? "assistant";
    const draft = options.drafts.get(options.thread.threadId);
    if (draft?.parentSessionId === options.thread.parentSessionId) {
      this.#composer.setValue(draft.text);
      this.#composeTarget = {
        parentSessionId: draft.parentSessionId,
        threadId: draft.threadId,
        expectedTurnId: draft.expectedTurnId,
        ...(draft.attentionId === undefined ? {} : { attentionId: draft.attentionId }),
      };
      this.#mode = draft.mode;
      if (draft.inputId !== undefined)
        this.#submission = {
          id: draft.inputId,
          text: draft.text,
          mode: draft.mode,
          turnId: draft.expectedTurnId,
        };
    }
    this.#composer.onSubmit = (text) => {
      void this.submit(text);
    };
    this.#activity = options.activity;
    this.#liveText = options.activity?.assistant?.text;
    this.#liveOmittedBytes = options.activity?.assistant?.omittedBytes ?? 0;
    this.refresh();
  }
  get focused(): boolean {
    return this.#focused;
  }
  set focused(value: boolean) {
    this.#focused = value;
    this.#composer.focused = value && this.#composing;
  }
  setExports(exports: readonly ManagedAgentExport[]): void {
    this.#exports = exports;
  }
  setCompletion(completion: ManagedWorkspaceSnapshot["completions"][number] | undefined): void {
    this.#completion = completion;
  }
  setThread(thread: ManagedControlThread): void {
    if (this.#thread.turn.turnId !== thread.turn.turnId) {
      this.#items = [];
      this.#olderCursor = null;
      this.#liveText = undefined;
      this.#liveOmittedBytes = 0;
      this.#manualPage = undefined;
      this.#currentCursor = null;
      this.#newerCursors = [];
      this.#pageGeneration += 1;
      this.#pageReadPending = false;
      this.#markdown.clear();
    }
    this.#thread = thread;
    if (
      this.#composing &&
      !this.#sending &&
      this.#composer.getValue().length === 0 &&
      this.canCompose() &&
      (!thread.actions?.includes(this.#mode) ||
        this.#composeTarget?.expectedTurnId !== thread.turn.turnId ||
        (this.#mode === "reply" && this.#composeTarget?.attentionId !== thread.turn.attention?.id))
    )
      this.selectCurrentTarget();
    this.refresh();
  }
  setActivity(activity: PresentationDisplayState["managedAgentActivity"]): void {
    this.#activity = activity?.find(
      (entry) =>
        entry.agentId === this.#thread.threadId && entry.attemptId === this.#thread.turn.attemptId,
    );
    if (this.#activity?.assistant !== undefined) {
      this.#liveText = this.#activity.assistant.text;
      this.#liveOmittedBytes = this.#activity.assistant.omittedBytes ?? 0;
    }
    this.refresh();
  }
  private refresh(): void {
    const thread = this.#thread;
    const key = `${thread.turn.turnId}:${thread.turn.phase}:${thread.turn.outcome?.transcript.sequence ?? ""}:${this.#activity?.activity ?? ""}:${this.#activity?.tool?.callId ?? ""}:${this.#activity?.tool?.status ?? ""}`;
    if (key === this.#readKey || this.#closed) return;
    this.#readKey = key;
    if (
      !thread.turn.hasStarted &&
      thread.turn.outcome?.status === "cancelled" &&
      thread.turn.outcome.transcript.sequence === 0
    ) {
      this.#items = [];
      this.#notice = "No agent session was started.";
      return;
    }
    const generation = ++this.#readGeneration;
    void this.options
      .onRead(thread, null)
      .then((page) => {
        if (this.#closed || generation !== this.#readGeneration) return;
        if (
          page.agentId !== thread.threadId ||
          page.turnId !== thread.turn.turnId ||
          page.childSessionId !== thread.turn.childSessionId
        )
          throw new Error("The exact agent transcript changed.");
        this.#items = page.items;
        this.#olderCursor = page.olderCursor;
        this.#currentCursor = page.cursor ?? null;
        if (this.#activity?.assistant === undefined) {
          this.#liveText = undefined;
          this.#liveOmittedBytes = 0;
        }
        this.pruneMarkdown();
        this.#notice = "";
        this.options.onChange();
      })
      .catch((error: unknown) => {
        if (this.#closed || generation !== this.#readGeneration) return;
        this.#notice =
          error instanceof Error ? error.message : "The bounded agent transcript is unavailable.";
        this.options.onChange();
      });
  }
  dispose(): void {
    this.#closed = true;
    this.#readGeneration += 1;
    this.#pageGeneration += 1;
    this.#markdown.clear();
  }
  private freezePage(): void {
    if (this.#manualPage === undefined)
      this.#manualPage = {
        items: this.#items,
        liveText: this.#liveText,
        liveOmittedBytes: this.#liveOmittedBytes,
        cursor: this.#currentCursor,
        olderCursor: this.#olderCursor,
      };
    this.#followTail = false;
  }
  private followTail(): void {
    this.#manualPage = undefined;
    this.#newerCursors = [];
    this.#followTail = true;
    this.#pageGeneration += 1;
    this.#pageReadPending = false;
    this.#readKey = "";
    this.refresh();
  }
  private loadPage(cursor: string | null, direction: "older" | "newer"): void {
    if (this.#pageReadPending) return;
    this.freezePage();
    const previous = this.#manualPage;
    const thread = this.#thread;
    const generation = ++this.#pageGeneration;
    this.#pageReadPending = true;
    this.#notice = "Loading transcript page…";
    void this.options
      .onRead(thread, cursor)
      .then((page) => {
        if (this.#closed || generation !== this.#pageGeneration) return;
        if (
          page.agentId !== thread.threadId ||
          page.turnId !== thread.turn.turnId ||
          page.childSessionId !== thread.turn.childSessionId
        )
          throw new Error("The exact transcript page changed.");
        if (direction === "older") this.#newerCursors.push(previous?.cursor ?? null);
        else this.#newerCursors.pop();
        this.#manualPage = {
          items: page.items,
          liveText: undefined,
          liveOmittedBytes: 0,
          cursor: page.cursor ?? null,
          olderCursor: page.olderCursor,
        };
        this.#scrollOffset = 0;
        this.#notice = "";
        this.pruneMarkdown();
      })
      .catch((error: unknown) => {
        if (!this.#closed && generation === this.#pageGeneration)
          this.#notice =
            error instanceof Error ? error.message : "The transcript page is unavailable.";
      })
      .finally(() => {
        if (!this.#closed && generation === this.#pageGeneration) {
          this.#pageReadPending = false;
          this.options.onChange();
        }
      });
  }
  private pruneMarkdown(): void {
    const retained = new Set(
      [...this.#items, ...(this.#manualPage?.items ?? [])].map((item) => item.id),
    );
    retained.add(`live:${this.#thread.turn.attemptId}`);
    retained.add(`outcome:${this.#thread.turn.turnId}`);
    for (const key of this.#markdown.keys()) if (!retained.has(key)) this.#markdown.delete(key);
  }
  private async submit(text: string): Promise<void> {
    if (this.#sending || this.#closed) return;
    if (text.trim().length === 0) {
      this.back();
      return;
    }
    const target = this.#composeTarget;
    if (target === undefined) return;
    if (
      this.#submission?.text !== text ||
      this.#submission.mode !== this.#mode ||
      this.#submission.turnId !== target.expectedTurnId
    )
      this.#submission = {
        id: randomUUID(),
        text,
        mode: this.#mode,
        turnId: target.expectedTurnId,
      };
    const inputId = this.#submission.id;
    const submittedDraft: ManagedComposerDraft = { ...target, mode: this.#mode, inputId, text };
    const common = {
      parentSessionId: target.parentSessionId,
      threadId: target.threadId,
      expectedTurnId: target.expectedTurnId,
      inputId,
      text,
    };
    const command: ManagedControlCommand =
      this.#mode === "reply"
        ? { ...common, type: "reply_agent", attentionId: target.attentionId ?? "" }
        : { ...common, type: "post_agent", mode: this.#mode };
    this.#sending = true;
    this.#inputNotice = "Accepting exact input…";
    this.options.onChange();
    let acceptanceRecorded = false;
    try {
      await this.saveLocalDraft();
      const receipt = await this.options.onSend(command);
      if (receipt.status === "rejected") this.#inputNotice = receipt.message;
      else if (
        receipt.control?.status === "input_accepted" ||
        receipt.control?.status === "accepted"
      ) {
        acceptanceRecorded = true;
        this.#lastInputId = inputId;
        this.#inputNotice = "Accepted";
        if (this.#composer.getValue() === text) {
          const cleared = await this.options.onClearDraft(submittedDraft);
          const current = this.options.drafts.get(target.threadId);
          if (
            cleared &&
            current?.inputId === inputId &&
            current.text === text &&
            current.expectedTurnId === target.expectedTurnId &&
            current.mode === submittedDraft.mode &&
            current.attentionId === submittedDraft.attentionId
          ) {
            this.#composer.setValue("");
            this.options.drafts.delete(target.threadId);
            if (this.#submission?.id === inputId) this.#submission = undefined;
          }
        }
        if (
          receipt.control.status === "accepted" &&
          this.#thread.turn.turnId === receipt.control.turnId
        ) {
          this.selectCurrentTarget();
        }
      } else this.#inputNotice = "The exact input was not accepted. Your draft is retained.";
    } catch {
      this.#inputNotice = acceptanceRecorded
        ? "Accepted; the private draft could not be cleared. Your text is retained."
        : "Input acceptance could not be confirmed. Your draft is retained.";
    } finally {
      this.#sending = false;
      if (!this.#closed) this.options.onChange();
    }
  }
  private selectCurrentTarget(): boolean {
    const thread = this.#thread;
    const mode = thread.actions?.includes("reply")
      ? "reply"
      : thread.actions?.includes("new_turn")
        ? "new_turn"
        : thread.actions?.includes("cooperative")
          ? "cooperative"
          : undefined;
    if (mode === undefined) {
      this.#inputNotice = "Input is unavailable for the current agent state.";
      return false;
    }
    this.#mode = mode;
    this.#composeTarget = {
      parentSessionId: thread.parentSessionId,
      threadId: thread.threadId,
      expectedTurnId: thread.turn.turnId,
      ...(this.#mode === "reply" && thread.turn.attention !== undefined
        ? { attentionId: thread.turn.attention.id }
        : {}),
    };
    this.#submission = undefined;
    return true;
  }
  private saveLocalDraft(): Promise<void> {
    const target = this.#composeTarget;
    if (target === undefined) return Promise.resolve();
    const text = this.#composer.getValue();
    const draft = {
      ...target,
      mode: this.#mode,
      text,
      ...(this.#submission?.text === text ? { inputId: this.#submission.id } : {}),
    };
    if (text.length === 0) this.options.drafts.delete(target.threadId);
    else this.options.drafts.set(target.threadId, draft);
    return this.options.onSaveDraft(draft).catch((error: unknown) => {
      this.#inputNotice = "The private child draft could not be saved. Your text is retained.";
      if (!this.#closed) this.options.onChange();
      throw error;
    });
  }
  back(): void {
    if (this.#exportView !== undefined) {
      if (this.#exportView.phase === "confirm") this.#exportView.phase = "fields";
      else this.#exportView = undefined;
    } else if (this.#suppressTarget !== undefined) {
      this.#suppressTarget = undefined;
    } else if (this.#details) {
      this.#details = false;
    } else if (this.#resources !== undefined) {
      this.#resources.generation += 1;
      this.#resources.pending = false;
      if (this.#resources.page !== undefined) {
        this.#resources.page = undefined;
        this.#resources.previousOffsets = [];
      } else this.#resources = undefined;
    } else if (this.#composing) {
      this.#composing = false;
      this.#composer.focused = false;
    } else this.options.onClose();
    this.options.onChange();
  }
  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (!isKeyRepeat(data) && !matchesKey(data, "x")) this.#cancelTarget = undefined;
    if (matchesKey(data, "enter") && isKeyRepeat(data)) return;
    if (this.#exportView !== undefined) {
      this.handleExportInput(data, this.#exportView);
      this.options.onChange();
      return;
    }
    if (this.#details) {
      if ((matchesKey(data, "escape") || data === "?") && !isKeyRepeat(data)) this.#details = false;
      else if (matchesKey(data, "home")) this.#detailScroll = 0;
      else if (matchesKey(data, "end")) this.#detailScroll = this.#detailMaximumScroll;
      else if (viewerKeys.up(data) || viewerKeys.pageUp(data))
        this.#detailScroll = Math.max(
          0,
          this.#detailScroll -
            (viewerKeys.up(data) ? 1 : Math.max(1, this.options.maximumLines() - 2)),
        );
      else if (viewerKeys.down(data) || viewerKeys.pageDown(data))
        this.#detailScroll = Math.min(
          this.#detailMaximumScroll,
          this.#detailScroll +
            (viewerKeys.down(data) ? 1 : Math.max(1, this.options.maximumLines() - 2)),
        );
      this.options.onChange();
      return;
    }
    if (!this.#composing && data === "?" && !isKeyRepeat(data)) {
      this.#details = true;
      this.#detailScroll = 0;
      this.options.onChange();
      return;
    }
    if (this.#resources !== undefined) {
      this.handleResourceInput(data);
      this.options.onChange();
      return;
    }
    if (
      !this.#composing &&
      !this.#retargetPending &&
      matchesKey(data, "e") &&
      !isKeyRepeat(data) &&
      this.#completion !== undefined
    ) {
      this.#suppressTarget = undefined;
      this.#exportView = {
        thread: this.#thread,
        completion: this.#completion,
        fields: new Set(["summary", "result"]),
        selected: 0,
        visible: new Set(),
        phase: "fields",
        confirmRendered: false,
        result: undefined,
        notice: "",
      };
      this.options.onChange();
      return;
    }
    if (!this.#composing && !this.#retargetPending && matchesKey(data, "s")) {
      if (isKeyRepeat(data) || this.#suppressPending) return;
      const completion = this.#completion;
      if (completion?.consumption !== "pending") return;
      const target = this.#suppressTarget;
      this.#suppressTarget = undefined;
      if (target === undefined) this.#suppressTarget = completion;
      else if (target.id !== completion.id || target.receipt.digest !== completion.receipt.digest)
        this.#inputNotice = "The completion changed. Select it again.";
      else {
        this.#suppressPending = true;
        this.#inputNotice = "Suppressing the exact completion…";
        void this.options
          .onSuppress(target)
          .then(
            (receipt) => {
              this.#inputNotice =
                receipt.status === "rejected"
                  ? receipt.message
                  : "Suppressed from automatic Main delivery.";
            },
            () => {
              this.#inputNotice = "Suppression could not be confirmed.";
            },
          )
          .finally(() => {
            this.#suppressPending = false;
            if (!this.#closed) this.options.onChange();
          });
      }
      this.options.onChange();
      return;
    }
    if (!matchesKey(data, "escape")) this.#suppressTarget = undefined;
    if (!this.#composing && !this.#retargetPending && matchesKey(data, "x")) {
      if (isKeyRepeat(data) || this.#cancelling) return;
      const target = this.#cancelTarget;
      this.#cancelTarget = undefined;
      if (target !== undefined && target.expectedTurnId !== this.#thread.turn.turnId)
        this.#inputNotice = "The turn changed. Start a new x x confirmation.";
      else if (this.#thread.actions?.includes("cancel")) {
        if (target === undefined)
          this.#cancelTarget = {
            parentSessionId: this.#thread.parentSessionId,
            threadId: this.#thread.threadId,
            expectedTurnId: this.#thread.turn.turnId,
          };
        else {
          this.#cancelling = true;
          void this.options
            .onSend({ ...target, type: "cancel_turn" })
            .then(
              (receipt) => {
                this.#inputNotice = receipt.status === "rejected" ? receipt.message : "Cancelled";
              },
              () => {
                this.#inputNotice = "Cancellation could not be confirmed. Inspect durable state.";
              },
            )
            .finally(() => {
              this.#cancelling = false;
              if (!this.#closed) this.options.onChange();
            });
        }
      }
      this.options.onChange();
      return;
    }
    if (!matchesKey(data, "x")) this.#cancelTarget = undefined;
    if (this.#retargetPending) {
      if (matchesKey(data, "enter")) {
        if (this.selectCurrentTarget()) {
          void this.saveLocalDraft().catch(() => undefined);
          this.#inputNotice = "Draft retargeted to the current turn.";
        }
        this.#retargetPending = false;
      } else if (matchesKey(data, "escape")) this.#retargetPending = false;
      this.options.onChange();
      return;
    }
    if (matchesKey(data, "escape")) {
      if (!isKeyRepeat(data)) this.back();
      return;
    }
    if (this.#composing) {
      if (this.#sending) return;
      if (
        matchesKey(data, "tab") &&
        this.#thread.actions?.includes("interrupt") &&
        (this.#mode === "cooperative" || this.#mode === "interrupt")
      ) {
        this.#mode = this.#mode === "cooperative" ? "interrupt" : "cooperative";
        this.#submission = undefined;
        void this.saveLocalDraft().catch(() => undefined);
        this.options.onChange();
        return;
      }
      const before = this.#composer.getValue();
      this.#composer.handleInput(data);
      if (this.#composer.getValue() !== before) void this.saveLocalDraft().catch(() => undefined);
    } else if (matchesKey(data, "enter") && !isKeyRepeat(data)) {
      if (this.#sending) return;
      if (!this.canCompose()) {
        this.#inputNotice = "Input is unavailable until this turn can accept it.";
        this.options.onChange();
        return;
      }
      if (
        (this.#composer.getValue().length === 0 || this.#composeTarget === undefined) &&
        !this.selectCurrentTarget()
      ) {
        this.options.onChange();
        return;
      }
      this.#composing = true;
      this.#composer.focused = this.#focused;
    } else if (matchesKey(data, "d") && !isKeyRepeat(data) && this.#composer.getValue()) {
      this.#composer.setValue("");
      void this.saveLocalDraft().catch(() => undefined);
      this.#composeTarget = undefined;
      this.#submission = undefined;
    } else if (matchesKey(data, "t") && !isKeyRepeat(data) && this.#composer.getValue()) {
      this.#retargetPending = true;
    } else if ((matchesKey(data, "v") || matchesKey(data, "i")) && !isKeyRepeat(data)) {
      this.#resources = {
        thread: this.#thread,
        entries: this.resourceEntries().filter(
          (entry) => !matchesKey(data, "i") || entry.kind === "input",
        ),
        inputOnly: matchesKey(data, "i"),
        selected: 0,
        visible: new Set(),
        page: undefined,
        previousOffsets: [],
        scroll: 0,
        maximumScroll: 0,
        pending: false,
        generation: 0,
        notice: "",
      };
    } else if (matchesKey(data, "m") && !isKeyRepeat(data)) {
      this.#renderMode = nextAgentViewerMode(this.#renderMode);
      void this.options.onRenderMode?.(this.#renderMode).then(
        (receipt) => {
          if (receipt.status === "rejected") {
            this.#notice = receipt.message;
            this.options.onChange();
          }
        },
        () => {
          this.#notice = "Viewer preference could not be saved.";
          this.options.onChange();
        },
      );
    } else if (matchesKey(data, "home")) {
      this.freezePage();
      this.#scrollOffset = 0;
    } else if (matchesKey(data, "end")) {
      this.followTail();
    } else if (viewerKeys.up(data) || viewerKeys.pageUp(data)) {
      this.freezePage();
      if (viewerKeys.pageUp(data) && this.#scrollOffset === 0 && this.#manualPage?.olderCursor)
        this.loadPage(this.#manualPage.olderCursor, "older");
      else
        this.#scrollOffset = Math.max(
          0,
          this.#scrollOffset - (viewerKeys.pageUp(data) ? this.#bodyHeight : 1),
        );
    } else if (viewerKeys.down(data) || viewerKeys.pageDown(data)) {
      if (this.#scrollOffset >= this.#maximumScroll && this.#newerCursors.length > 0)
        this.loadPage(this.#newerCursors.at(-1) ?? null, "newer");
      else {
        this.#scrollOffset = Math.min(
          this.#maximumScroll,
          this.#scrollOffset + (viewerKeys.pageDown(data) ? this.#bodyHeight : 1),
        );
        if (this.#scrollOffset >= this.#maximumScroll && this.#newerCursors.length === 0)
          this.followTail();
      }
    }
    this.options.onChange();
  }
  invalidate(): void {}
  private canCompose(): boolean {
    return (
      this.#thread.actions?.some(
        (action) =>
          action === "cooperative" ||
          action === "interrupt" ||
          action === "new_turn" ||
          action === "reply",
      ) ?? false
    );
  }
  private textLines(
    id: string,
    text: string,
    width: number,
    kind: "assistant" | "tool" | "literal" = "assistant",
  ): string[] {
    const bytes = Buffer.from(text, "utf8");
    let end = Math.min(bytes.byteLength, presentationArtifactPageMaximumBytes);
    while (end > 0 && end < bytes.byteLength && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
    const safe = safeTerminalText(bytes.subarray(0, end).toString("utf8"));
    const omission =
      end < bytes.byteLength
        ? [truncateToWidth(`… ${bytes.byteLength - end} bytes omitted · v resources`, width)]
        : [];
    if (
      this.#renderMode === "raw" ||
      kind === "literal" ||
      (kind === "tool" && this.#renderMode !== "full") ||
      /^(?:diff --git |@@ |--- |\+\+\+ |#!|\$ |\d{4}-\d\d-\d\d[T ])/mu.test(safe)
    )
      return [...wrapTextWithAnsi(safe, width), ...omission];
    let entry = this.#markdown.get(id);
    if (entry === undefined) {
      entry = {
        component: new Markdown(safe, 0, 0, this.options.theme.markdown, undefined, {
          preserveOrderedListMarkers: true,
          preserveBackslashEscapes: true,
        }),
        text: safe,
        failed: false,
      };
      this.#markdown.set(id, entry);
    } else if (entry.text !== safe) {
      if (!safe.startsWith(entry.text)) entry.failed = false;
      entry.text = safe;
      entry.component.setText(safe);
    }
    if (!entry.failed) {
      try {
        return [...entry.component.render(width), ...omission];
      } catch {
        entry.failed = true;
      }
    }
    return [...wrapTextWithAnsi(safe, width), ...omission];
  }
  private handleExportInput(data: string, state: ExportView): void {
    if (matchesKey(data, "escape")) {
      if (!isKeyRepeat(data)) this.back();
      return;
    }
    if (state.phase === "pending") return;
    if (state.phase === "ready") {
      if (matchesKey(data, "v") && !isKeyRepeat(data) && state.result !== undefined) {
        this.#exportView = undefined;
        this.#resources = {
          thread: state.thread,
          entries: [
            { kind: "artifact", artifact: state.result.artifact, label: "Confirmed export" },
          ],
          selected: 0,
          visible: new Set([0]),
          page: undefined,
          previousOffsets: [],
          scroll: 0,
          maximumScroll: 0,
          pending: false,
          generation: 0,
          notice: "",
        };
        this.readResource(
          { offset: 0, maximumBytes: presentationArtifactPageMaximumBytes },
          "first",
        );
      }
      return;
    }
    if (state.phase === "confirm") {
      if (!matchesKey(data, "enter") || isKeyRepeat(data) || !state.confirmRendered) return;
      state.phase = "pending";
      const fields = agentExportFields.filter((field) => state.fields.has(field));
      void this.options.onExport(state.thread, state.completion, fields).then(
        (receipt) => {
          if (this.#closed || this.#exportView !== state) return;
          if (receipt.status === "rejected" || receipt.agentExport === undefined) {
            state.phase = "fields";
            state.notice =
              receipt.status === "rejected"
                ? receipt.message
                : "The export receipt is unavailable.";
          } else {
            state.result = receipt.agentExport;
            state.phase = "ready";
          }
          this.options.onChange();
        },
        () => {
          if (!this.#closed && this.#exportView === state) {
            state.phase = "fields";
            state.notice = "The selected fields could not be exported.";
            this.options.onChange();
          }
        },
      );
      return;
    }
    if (matchesKey(data, "home")) state.selected = 0;
    else if (matchesKey(data, "end")) state.selected = agentExportFields.length - 1;
    else if (viewerKeys.up(data)) state.selected = Math.max(0, state.selected - 1);
    else if (viewerKeys.down(data))
      state.selected = Math.min(agentExportFields.length - 1, state.selected + 1);
    else if (matchesKey(data, "space") && !isKeyRepeat(data) && state.visible.has(state.selected)) {
      const field = agentExportFields[state.selected];
      if (field !== undefined && !state.fields.delete(field)) state.fields.add(field);
    } else if (matchesKey(data, "enter") && !isKeyRepeat(data)) {
      if (state.fields.size === 0) state.notice = "Choose at least one field.";
      else {
        state.phase = "confirm";
        state.confirmRendered = false;
        state.notice = "";
      }
    }
  }
  private renderExport(width: number, state: ExportView): string[] {
    const maximum = this.options.maximumLines();
    if (state.phase === "pending")
      return [
        "Exporting confirmed fields…",
        `${state.thread.handle} · ${state.thread.turn.turnId.slice(0, 8)}`,
        "Esc close",
      ].map((line) => truncateToWidth(line, width));
    if (state.phase === "ready" && state.result !== undefined)
      return [
        this.options.theme.primary(`Export ready · ${state.thread.handle}`),
        `${state.result.artifact.byteCount} bytes · JSON`,
        ...wrapTextWithAnsi(state.result.artifact.id, width),
        "v open export · Esc back",
      ].map((line) => truncateToWidth(line, width));
    if (state.phase === "confirm") {
      const lines = [
        this.options.theme.primary("Confirm export"),
        `${state.thread.handle} · turn ${state.thread.turn.turnId.slice(0, 8)}`,
        ...wrapTextWithAnsi(
          `Fields: ${agentExportFields.filter((field) => state.fields.has(field)).join(", ")}`,
          width,
        ),
        state.fields.has("reasoning") ? "Reasoning INCLUDED" : "Reasoning excluded",
        "Enter export · Esc fields",
      ];
      state.confirmRendered = lines.length <= maximum;
      return lines.map((line) => truncateToWidth(line, width));
    }
    const labels: Record<AgentExportField, string> = {
      summary: "Summary",
      conversation: "Conversation (assistant)",
      tools: "Tool records",
      result: "Result",
      reasoning: "Reasoning (separate opt-in)",
    };
    const count = Math.max(1, maximum - 3 - Number(Boolean(state.notice)));
    const start = Math.max(0, state.selected - count + 1);
    const visible = agentExportFields.slice(start, start + count);
    state.visible = new Set(visible.map((_, index) => start + index));
    return [
      this.options.theme.primary(`Export agent · ${state.thread.handle}`),
      `16 KiB / 32 items · ${agentExportFields.length - visible.length} hidden`,
      ...visible.map(
        (field, index) =>
          `${start + index === state.selected ? "●" : "○"} [${state.fields.has(field) ? "x" : " "}] ${labels[field]}`,
      ),
      ...(state.notice ? [safeTerminalText(state.notice)] : []),
      "Space toggle · Enter review · Esc back",
    ].map((line) => truncateToWidth(line, width));
  }
  private resourceEntries(): readonly AgentConversationResource[] {
    const entries: AgentConversationResource[] = [];
    const artifacts = new Set<string>();
    const addArtifact = (artifact: ArtifactReference, label = "Artifact") => {
      if (artifacts.has(artifact.id)) return;
      artifacts.add(artifact.id);
      entries.push({ kind: "artifact", artifact, label: `${label} · ${artifact.byteCount} bytes` });
    };
    for (const item of this.#manualPage?.items ?? this.#items) {
      if (item.type === "reasoning_block")
        entries.push({ kind: "reasoning", itemId: item.id, label: `Reasoning · ${item.status}` });
      else if (item.type === "tool_call") {
        entries.push({
          kind: "tool",
          itemId: item.id,
          label: `Tool · ${item.qualifiedName} · ${item.status}`,
        });
        for (const artifact of item.artifacts) addArtifact(artifact);
      } else if (item.type === "assistant_message" && item.artifact !== null)
        addArtifact(item.artifact, "Assistant output");
    }
    const result = this.#thread.turn.outcome?.artifact;
    if (result !== undefined)
      addArtifact({ ...result, source: "model_response" }, "Result artifact");
    for (const input of this.#thread.inputs ?? []) {
      if (input.turnId === this.#thread.turn.turnId)
        entries.push({
          kind: "input",
          inputId: input.id,
          label: `${input.status === "undelivered" ? "Undelivered" : input.status === "delivered" ? "Delivered" : "Accepted"}${input.reason === undefined ? "" : ` · ${input.reason}`} · ${input.id.slice(0, 8)}`,
        });
    }
    for (const exported of this.#exports)
      addArtifact(exported.artifact, `Export · ${exported.fields.join(", ")}`);
    return entries;
  }
  private readResource(range: ArtifactRange, direction: "first" | "next" | "previous"): void {
    const state = this.#resources;
    const entry = state?.entries[state.selected];
    if (state === undefined || entry === undefined || state.pending) return;
    state.pending = true;
    state.notice = "Loading bounded resource…";
    const generation = ++state.generation;
    void this.options
      .onReadResource(state.thread, entry, range)
      .then((page) => {
        if (this.#closed || this.#resources !== state || state.generation !== generation) return;
        if (direction === "next" && state.page !== undefined)
          state.previousOffsets.push(state.page.offset);
        else if (direction === "previous") state.previousOffsets.pop();
        else state.previousOffsets = [];
        state.page = page;
        state.scroll = 0;
        state.notice = "";
      })
      .catch((error: unknown) => {
        if (!this.#closed && this.#resources === state && state.generation === generation)
          state.notice = error instanceof Error ? error.message : "The resource is unavailable.";
      })
      .finally(() => {
        if (!this.#closed && this.#resources === state && state.generation === generation) {
          state.pending = false;
          this.options.onChange();
        }
      });
  }
  private handleResourceInput(data: string): void {
    const state = this.#resources;
    if (state === undefined) return;
    if (matchesKey(data, "escape")) {
      if (!isKeyRepeat(data)) this.back();
      return;
    }
    if (state.pending) return;
    if (state.page === undefined) {
      if (viewerKeys.down(data))
        state.selected = Math.min(state.entries.length - 1, state.selected + 1);
      else if (viewerKeys.up(data)) state.selected = Math.max(0, state.selected - 1);
      else if (matchesKey(data, "home")) state.selected = 0;
      else if (matchesKey(data, "end")) state.selected = Math.max(0, state.entries.length - 1);
      else if (matchesKey(data, "enter") && state.visible.has(state.selected))
        this.readResource(
          { offset: 0, maximumBytes: presentationArtifactPageMaximumBytes },
          "first",
        );
      return;
    }
    const entry = state.entries[state.selected];
    if (!matchesKey(data, "b")) state.restoreArmed = false;
    if (
      matchesKey(data, "b") &&
      !isKeyRepeat(data) &&
      entry?.kind === "input" &&
      state.page.offset === 0 &&
      state.page.eof
    ) {
      if (!this.canCompose() || this.#thread.turn.turnId !== state.thread.turn.turnId) {
        state.notice = "The selected turn changed or cannot accept a draft.";
        return;
      }
      if (!state.restoreArmed) {
        state.restoreArmed = true;
        state.notice = `Return input as draft · b confirm${this.#composer.getValue() ? " · replaces current child draft" : ""}`;
        return;
      }
      if (!this.selectCurrentTarget()) return;
      this.#composer.setValue(state.page.text);
      this.#submission = undefined;
      this.#composing = false;
      this.#composer.focused = false;
      this.#resources = undefined;
      this.#inputNotice = "Input restored as a draft. Nothing sent.";
      void this.saveLocalDraft().catch(() => undefined);
      return;
    }
    if (matchesKey(data, "n") && !isKeyRepeat(data) && state.page.nextRange !== null)
      this.readResource(state.page.nextRange, "next");
    else if (matchesKey(data, "p") && !isKeyRepeat(data) && state.previousOffsets.length > 0)
      this.readResource(
        {
          offset: state.previousOffsets.at(-1) ?? 0,
          maximumBytes: presentationArtifactPageMaximumBytes,
        },
        "previous",
      );
    else if (matchesKey(data, "home")) state.scroll = 0;
    else if (matchesKey(data, "end")) state.scroll = state.maximumScroll;
    else if (viewerKeys.up(data) || viewerKeys.pageUp(data))
      state.scroll = Math.max(
        0,
        state.scroll - (viewerKeys.up(data) ? 1 : Math.max(1, this.options.maximumLines() - 4)),
      );
    else if (viewerKeys.down(data) || viewerKeys.pageDown(data))
      state.scroll = Math.min(
        state.maximumScroll,
        state.scroll + (viewerKeys.down(data) ? 1 : Math.max(1, this.options.maximumLines() - 4)),
      );
  }
  private renderResources(width: number, state: ResourceView): string[] {
    const maximum = Math.max(4, this.options.maximumLines());
    if (state.page === undefined) {
      const count = Math.max(1, maximum - 4);
      const start = Math.max(0, state.selected - count + 1);
      const entries = state.entries.slice(start, start + count);
      state.visible = new Set(entries.map((_, index) => start + index));
      return [
        this.options.theme.primary(
          `${state.inputOnly ? "Input receipts" : "Conversation resources"} · ${state.thread.handle}`,
        ),
        ...entries.map(
          (entry, index) =>
            `${start + index === state.selected ? "●" : "○"} ${safeTerminalText(entry.label)}`,
        ),
        ...(entries.length === 0 ? ["No resources on this transcript page."] : []),
        ...(start > 0 || start + entries.length < state.entries.length
          ? [`↑ ${start} hidden · ↓ ${state.entries.length - start - entries.length} hidden`]
          : []),
        ...(state.notice ? [safeTerminalText(state.notice)] : []),
        "Enter open · Esc conversation",
      ].map((line) => truncateToWidth(line, width));
    }
    const entry = state.entries[state.selected];
    const page = state.page;
    const body = wrapTextWithAnsi(safeTerminalText(page.text), width);
    const footer = [
      ...(entry?.kind === "input" &&
      state.thread.turn.turnId === this.#thread.turn.turnId &&
      this.canCompose() &&
      page.offset === 0 &&
      page.eof
        ? ["b return to draft"]
        : []),
      ...(state.notice ? [safeTerminalText(state.notice)] : []),
      `${page.nextRange === null ? "End of resource" : "n next"}${state.previousOffsets.length > 0 ? " · p previous" : ""} · Esc resources`,
    ];
    const height = Math.max(1, maximum - footer.length - 2);
    state.maximumScroll = Math.max(0, body.length - height);
    state.scroll = Math.min(state.scroll, state.maximumScroll);
    return [
      this.options.theme.primary(
        `${entry?.kind === "reasoning" ? "Reasoning" : entry?.kind === "tool" ? "Tool" : entry?.kind === "input" ? "Input" : "Artifact"} page · ${state.thread.handle} · literal`,
      ),
      `Bytes ${page.offset}-${page.offset + page.byteCount} of ${page.totalByteCount}`,
      ...body.slice(state.scroll, state.scroll + height),
      ...footer,
    ].map((line) => truncateToWidth(line, width));
  }
  render(width: number): string[] {
    const completion = this.#completion;
    if (
      this.#focused &&
      completion !== undefined &&
      completion.turnId === this.#thread.turn.turnId &&
      !completion.userSeen &&
      !this.#seenAttempts.has(completion.id)
    ) {
      this.#seenAttempts.add(completion.id);
      void this.options.onSeen(completion).then(
        (receipt) => {
          if (receipt.status === "rejected") {
            this.#notice = receipt.message;
            this.options.onChange();
          }
        },
        () => {
          this.#notice = "The Seen state could not be recorded.";
          this.options.onChange();
        },
      );
    }
    if (this.#exportView !== undefined) return this.renderExport(width, this.#exportView);
    if (this.#resources !== undefined) return this.renderResources(width, this.#resources);
    const thread = this.#thread;
    const config = thread.turn.configuration;
    const olderCursor =
      this.#manualPage === undefined ? this.#olderCursor : this.#manualPage.olderCursor;
    const liveOmittedBytes =
      this.#manualPage === undefined ? this.#liveOmittedBytes : this.#manualPage.liveOmittedBytes;
    const header = [
      this.options.theme.primary(`Conversation · ${thread.handle} · ${thread.displayName}`),
      safeTerminalText(thread.description),
      config === undefined
        ? "Recorded target unavailable"
        : `${safeTerminalText(config.targetId)} · thinking ${safeTerminalText(config.thinking)}`,
      `${config?.contextWindowTokens ?? "unknown"} context · ${thread.budget?.knownUsed ?? 0} used · ${thread.budget?.outstandingReserved ?? 0} reserved`,
      ...(thread.budget === undefined
        ? []
        : [
            `${thread.budget.unknownReserved} unknown reserved · ${thread.budget.available} available`,
          ]),
      `${thread.turn.label}${agentElapsedLabel(thread)}`,
      ...(this.#activity?.tool?.status === "generating_arguments"
        ? [`Generating arguments · ${safeTerminalText(this.#activity.tool.name)}`]
        : []),
      ...(thread.turn.diagnostic === undefined
        ? []
        : wrapTextWithAnsi(safeTerminalText(thread.turn.diagnostic), width)),
      ...(thread.turn.attention?.question === undefined
        ? []
        : wrapTextWithAnsi(safeTerminalText(thread.turn.attention.question), width)),
    ];
    const footer = [
      ...(completion === undefined
        ? []
        : [
            `${completion.userSeen ? "Seen" : "Unseen"} · Main ${completion.consumption}`,
            ...(!this.#composing ? ["e export"] : []),
          ]),
      ...(this.#suppressTarget !== undefined
        ? [
            "Suppress from Main? s confirm · Esc cancel",
            "Skip automatic delivery of this completion.",
          ]
        : completion?.consumption === "pending" && !this.#composing
          ? ["s Suppress from Main"]
          : []),
      ...(this.#cancelTarget === undefined
        ? !this.#composing && thread.actions?.includes("cancel")
          ? ["x x cancel"]
          : []
        : [`x again to cancel ${thread.handle}`]),
      ...(this.#retargetPending
        ? ["Retarget draft to the current turn? Enter confirm · Esc cancel"]
        : []),
      ...(this.#composeTarget !== undefined &&
      this.#composer.getValue() &&
      this.#composeTarget.expectedTurnId !== thread.turn.turnId
        ? ["Draft targets an earlier turn · d discard · t retarget"]
        : []),
      `${this.#followTail ? "Following tail" : "Manual scroll · End tail"} · m ${this.#renderMode === "raw" ? "raw" : `${this.#renderMode} Markdown`}`,
      ...(olderCursor === null ? [] : ["PgUp at top: older transcript page"]),
      ...(this.#newerCursors.length === 0 ? [] : ["PgDown at bottom: newer page · End latest"]),
      ...(this.#notice ? [safeTerminalText(this.#notice)] : []),
      ...(liveOmittedBytes > 0 ? [`Live preview · ${liveOmittedBytes} bytes omitted`] : []),
      ...(this.resourceEntries().length > 0 ? ["v resources · i input receipts"] : []),
      ...(() => {
        const input =
          thread.inputs?.find((entry) => entry.id === this.#lastInputId) ??
          thread.inputs?.findLast(
            (entry) => entry.turnId === thread.turn.turnId && entry.status === "undelivered",
          );
        const text =
          input?.status === "delivered"
            ? "Delivered"
            : input?.status === "undelivered"
              ? `Undelivered · ${input.reason ?? "delivery unavailable"} · Inspect before sending again`
              : this.#inputNotice;
        return text ? [safeTerminalText(text)] : [];
      })(),
      ...(this.#composing
        ? [
            `To ${thread.handle} · ${thread.displayName} · ${thread.turn.label} · ${this.#mode === "new_turn" ? "New turn" : this.#mode === "reply" ? "Reply to parent input" : this.#mode === "interrupt" ? "Interrupt after current effect" : "Cooperative"}`,
            ...this.#composer.render(width),
            this.#mode === "cooperative" || this.#mode === "interrupt"
              ? "Enter send · Tab delivery mode · Esc viewer"
              : "Enter send · Esc viewer",
          ]
        : [
            ...(this.#composer.getValue() ? [`Draft to ${thread.handle}`] : []),
            this.canCompose()
              ? "Enter compose · Esc back"
              : this.#thread.turn.phase === "settling"
                ? "Settling · input available after cleanup · Esc back"
                : "Input unavailable · Esc back",
          ]),
    ];
    const body = (this.#manualPage?.items ?? this.#items).flatMap((item) => {
      if (item.type === "assistant_message")
        return this.textLines(item.id, item.text ?? "Assistant output in artifact", width);
      if (item.type === "tool_call") {
        const lines = wrapTextWithAnsi(
          safeTerminalText(
            `Tool · ${item.label} · ${item.status}${item.resultSummary === null ? "" : ` · ${item.resultSummary}`}`,
          ),
          width,
        );
        if (item.preview?.kind === "read_text") {
          const preview = item.preview;
          lines.push(
            ...this.textLines(
              `${item.id}:result`,
              preview.lines.map((line) => line.text).join("\n"),
              width,
              preview.language === null ||
                preview.language === "text" ||
                preview.language === "markdown"
                ? "tool"
                : "literal",
            ),
          );
          if (preview.omittedBytes > 0)
            lines.push(`… ${preview.omittedBytes} bytes omitted · v resources`);
          if (preview.sourceTruncated) lines.push("Tool output truncated at source");
        } else if (item.preview !== null)
          lines.push(...new ToolPreview(item.preview, true, this.options.theme).render(width));
        return lines;
      }
      if (item.type === "reasoning_block") return [`Reasoning · ${item.status}`];
      if (item.type === "session_notice") return [`Session · ${item.status}`];
      if (item.type === "compaction_marker") return ["Context compacted"];
      return [];
    });
    const liveText = this.#manualPage === undefined ? this.#liveText : this.#manualPage.liveText;
    if (liveText) body.push(...this.textLines(`live:${thread.turn.attemptId}`, liveText, width));
    if (body.length === 0 && this.#manualPage === undefined && thread.turn.outcome !== undefined)
      body.push(
        ...this.textLines(`outcome:${thread.turn.turnId}`, thread.turn.outcome.summary, width),
      );
    const maximum = this.options.maximumLines();
    if (this.#details) {
      const details = [
        ...header.slice(1),
        `Rendering: ${this.#renderMode} · m cycles raw/assistant/full`,
        "Enter: focus the independent child editor",
        "Esc: editor to viewer to Fleet to Main",
        "x x: cancel the exact turn",
        "v: bounded resources · i: exact input receipts",
        "d: discard retained draft · t: confirm retarget",
        "Home/End: scroll start/follow tail",
        "j/k or configured arrows: scroll",
        "PgUp/PgDown or Shift+arrows: page and bounded transcript",
      ].flatMap((line) => wrapTextWithAnsi(safeTerminalText(line), width));
      const height = Math.max(1, maximum - 2);
      this.#detailMaximumScroll = Math.max(0, details.length - height);
      this.#detailScroll = Math.min(this.#detailScroll, this.#detailMaximumScroll);
      return [
        this.options.theme.primary(`Conversation details · ${thread.handle}`),
        ...details.slice(this.#detailScroll, this.#detailScroll + height),
        `↑↓ scroll · ${details.length - Math.min(height, details.length)} hidden · Esc back`,
      ].map((line) => truncateToWidth(line, width));
    }
    if (header.length + footer.length + 1 > maximum) {
      const mode =
        this.#mode === "new_turn"
          ? "New turn"
          : this.#mode === "reply"
            ? "Reply"
            : this.#mode === "interrupt"
              ? "Interrupt"
              : "Cooperative";
      const input =
        thread.inputs?.find((entry) => entry.id === this.#lastInputId) ??
        thread.inputs?.findLast(
          (entry) => entry.turnId === thread.turn.turnId && entry.status === "undelivered",
        );
      const notice =
        input?.status === "delivered"
          ? "Delivered"
          : input?.status === "undelivered"
            ? `Undelivered · ${input.reason ?? "unavailable"}`
            : this.#inputNotice ||
              this.#notice ||
              (completion === undefined
                ? ""
                : `${completion.userSeen ? "Seen" : "Unseen"} · Main ${completion.consumption}`);
      const essential = this.#composing
        ? [
            ...(notice ? [safeTerminalText(notice)] : []),
            `To ${thread.handle} · ${mode}`,
            ...this.#composer.render(width),
            `Enter send${this.#mode === "cooperative" || this.#mode === "interrupt" ? " · Tab" : ""} · Esc viewer`,
          ]
        : [
            ...(this.#composer.getValue() ? [`Draft to ${thread.handle} · d/t`] : []),
            ...(this.#suppressTarget !== undefined
              ? ["Suppress from Main? s confirm", "Esc cancel · skip automatic delivery"]
              : this.#retargetPending
                ? ["Retarget draft? Enter confirm · Esc cancel"]
                : notice
                  ? [safeTerminalText(notice)]
                  : []),
            ...(this.#cancelTarget === undefined ? [] : [`x again to cancel ${thread.handle}`]),
            `${this.canCompose() ? "Enter compose" : "Input unavailable"}${completion?.consumption === "pending" ? " · s" : ""}${completion === undefined ? "" : " · e export"}${thread.actions?.includes("cancel") ? " · x x" : ""}${this.resourceEntries().length > 0 ? " · v/i" : ""} · Esc back`,
          ];
      const compactBody = body.length === 0 ? [thread.turn.label] : body;
      this.#bodyHeight = Math.max(0, maximum - 2 - essential.length);
      this.#maximumScroll = Math.max(0, compactBody.length - this.#bodyHeight);
      this.#scrollOffset = this.#followTail
        ? this.#maximumScroll
        : Math.min(this.#scrollOffset, this.#maximumScroll);
      const hidden =
        header.length -
        1 +
        Math.max(0, footer.length - essential.length) +
        Math.max(0, compactBody.length - this.#bodyHeight);
      return [
        this.options.theme.primary(`Conversation · ${thread.handle}`),
        `${hidden} lines hidden · m ${this.#renderMode} · ?`,
        ...compactBody.slice(this.#scrollOffset, this.#scrollOffset + this.#bodyHeight),
        ...essential,
      ].map((line) => truncateToWidth(line, width));
    }
    this.#bodyHeight = Math.max(1, this.options.maximumLines() - header.length - footer.length);
    this.#maximumScroll = Math.max(0, body.length - this.#bodyHeight);
    this.#scrollOffset = this.#followTail
      ? this.#maximumScroll
      : Math.min(this.#scrollOffset, this.#maximumScroll);
    return [
      ...header,
      ...body.slice(this.#scrollOffset, this.#scrollOffset + this.#bodyHeight),
      ...footer,
    ].map((line) => truncateToWidth(line, width));
  }
}
