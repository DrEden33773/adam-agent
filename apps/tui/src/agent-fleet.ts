/**
 * Fleet navigation adapted from tintinweb/pi-subagents src/ui/fleet-list.ts
 * at 4f572eaa04c09d3dbc16e4a5f13a16b295e84e14 (MIT). See THIRD_PARTY_NOTICES.md.
 * Stable selection and drafts are local UI state; Control owns threads and turns.
 */
import type {
  AgentUiSettings,
  CommandReceipt,
  ManagedComposerDraft,
  ManagedControlCommand,
  ManagedControlThread,
  ManagedSessionTransition,
  ManagedWorkspaceSnapshot,
} from "@adam-agent/presentation";
import { defaultAgentUiSettings, nextAgentViewerMode } from "@adam-agent/presentation";
import {
  type Component,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  SelectList,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  agentElapsedLabel,
  agentHeading,
  agentSelectionRow,
  agentStatus,
  agentTimedLine,
} from "./agent-view-format.js";
import { focusedWheelDirection } from "./focused-wheel-input.js";
import { safeTerminalText } from "./safe-terminal-text.js";
import type { AdamTuiTheme } from "./theme.js";

export class AgentFleet implements Component {
  #snapshot: ManagedWorkspaceSnapshot | undefined;
  #threads: readonly ManagedControlThread[] = [];
  #active = false;
  #selected: string | null = null;
  #visibleIds = new Set<string | null>();
  readonly drafts = new Map<string, ManagedComposerDraft>();
  constructor(
    private readonly options: {
      readonly theme: AdamTuiTheme;
      readonly onChange: () => void;
      readonly onOpen: (thread: ManagedControlThread) => void;
      readonly maximumLines?: () => number;
      readonly hasDraft?: (thread: ManagedControlThread) => boolean;
    },
  ) {}
  setSnapshot(
    snapshot: ManagedWorkspaceSnapshot | undefined,
    visibleThreads: readonly ManagedControlThread[] = snapshot?.threads ?? [],
  ): void {
    if (this.#snapshot?.parentSessionId !== snapshot?.parentSessionId) {
      this.#active = false;
      this.#selected = null;
    }
    this.#snapshot = snapshot;
    this.#threads = visibleThreads;
    if (
      this.#selected !== null &&
      !this.rows().some((thread) => thread.threadId === this.#selected)
    )
      this.#selected = null;
  }
  private rows(): readonly ManagedControlThread[] {
    return this.#threads.filter((thread) => thread.turn.hasStarted && thread.lifecycle === "open");
  }
  handleMainInput(data: string, empty: boolean): boolean {
    if (this.#snapshot === undefined || this.rows().length === 0) return false;
    if (isKeyRelease(data)) return this.#active;
    const wheel = focusedWheelDirection(data);
    if (wheel !== null) {
      if (!this.#active || !empty) return false;
      data = wheel < 0 ? "\u001b[A" : "\u001b[B";
    }
    if (!empty) {
      this.#active = false;
      return false;
    }
    if (!this.#active) {
      if (!matchesKey(data, "down") && !matchesKey(data, "left")) return false;
      this.#active = true;
      this.#selected = null;
    } else {
      const rows = this.rows();
      const index = rows.findIndex((thread) => thread.threadId === this.#selected);
      if (matchesKey(data, "down"))
        this.#selected = rows[Math.min(index + 1, rows.length - 1)]?.threadId ?? null;
      else if (matchesKey(data, "up")) {
        if (index < 0) this.#active = false;
        this.#selected = rows[index - 1]?.threadId ?? null;
      } else if (matchesKey(data, "escape")) this.#active = false;
      else if (matchesKey(data, "enter")) {
        if (isKeyRepeat(data)) return true;
        const thread = rows.find((row) => row.threadId === this.#selected);
        if (thread !== undefined && this.#visibleIds.has(thread.threadId))
          this.options.onOpen(thread);
        else this.#active = false;
      } else {
        this.#active = false;
        this.options.onChange();
        return false;
      }
    }
    this.options.onChange();
    return true;
  }
  invalidate(): void {}
  render(width: number): string[] {
    const rows = this.rows();
    if (rows.length === 0) return [];
    const maximum = this.options.maximumLines?.() ?? 7;
    const theme = this.options.theme;
    const entries = [
      { id: null, text: theme.text("Main"), identity: "Main" },
      ...rows.map((thread) => ({
        id: thread.threadId,
        identity: thread.handle,
        text: agentTimedLine(
          theme,
          `${theme.reference(safeTerminalText(thread.handle))} · ${agentStatus(theme, thread)}${width >= 72 ? ` · ${theme.muted(safeTerminalText(thread.displayName))}` : ""} · ${theme.text(safeTerminalText(thread.description))}${this.drafts.get(thread.threadId)?.text || this.options.hasDraft?.(thread) ? theme.muted(` · Draft to ${thread.handle}`) : ""}`,
          thread,
          Math.max(0, width - 2),
        ),
      })),
    ];
    const selectedIndex = Math.max(
      0,
      entries.findIndex((entry) => entry.id === this.#selected),
    );
    if (maximum === 1) {
      const entry = entries[this.#active ? selectedIndex : 0];
      this.#visibleIds = new Set([entry?.id ?? null]);
      const line = truncateToWidth(
        `${(this.#active ? theme.toolTitle : theme.muted)("Fleet")} ${this.#active ? theme.toolTitle(">") : " "} ${theme.reference(entry?.identity ?? "Main")} · ${theme.muted(`+${entries.length - 1} · ${this.#active ? "Enter/Esc" : "↓ navigate"}`)}`,
        width,
      );
      return [
        this.#active
          ? theme.selectionBackground(line + " ".repeat(Math.max(0, width - visibleWidth(line))))
          : line,
      ];
    }
    const body = Math.max(1, maximum - 1);
    const start = Math.max(0, selectedIndex - body + 1);
    const visible = entries.slice(start, start + body);
    const below = entries.length - start - visible.length;
    this.#visibleIds = new Set(visible.map((entry) => entry.id));
    const overflow = `${start ? ` · ${start} above` : ""}${below ? ` · ${below} below` : ""}`;
    const hint = this.#active ? (width < 60 ? "Enter/Esc" : "Enter open · Esc Main") : "↓ navigate";
    return [
      (this.#active ? theme.toolTitle : theme.muted)(`Fleet · ${hint}${overflow}`),
      ...visible.map((entry) =>
        agentSelectionRow(theme, entry.text, this.#active && this.#selected === entry.id, width),
      ),
    ].map((line) => truncateToWidth(line, width));
  }
}

/** The full list retains individually addressable queued and historical threads. */
export class AgentWorkspace implements Component {
  #snapshot: ManagedWorkspaceSnapshot;
  #settings: AgentUiSettings;
  #settingsOpen = false;
  #settingIndex = 0;
  #visibleSettings = new Set<number>();
  #selected: string | undefined;
  #detail = false;
  #help = false;
  #helpScroll = 0;
  #helpMaximumScroll = 0;
  #detailScroll = 0;
  #detailMaximumScroll = 0;
  #history = false;
  #resumeTargets:
    | readonly { readonly threadId: string; readonly expectedTurnId: string }[]
    | undefined;
  #closeTarget: { readonly threadId: string; readonly turnId: string } | undefined;
  #notice = "";
  #armed: { readonly threadId: string; readonly turnId: string } | undefined;
  #pending = false;
  #visibleIds = new Set<string>();
  constructor(
    private readonly options: {
      readonly snapshot: ManagedWorkspaceSnapshot;
      readonly settings?: AgentUiSettings | undefined;
      readonly initialView?: "workspace" | "settings" | "history";
      readonly onSettings: (settings: AgentUiSettings | null) => Promise<CommandReceipt>;
      readonly onAttention: () => void;
      readonly onTypes?: () => void;
      readonly theme: AdamTuiTheme;
      readonly maximumLines: () => number;
      readonly onChange: () => void;
      readonly onClose: () => void;
      readonly onOpen: (thread: ManagedControlThread, readOnly?: boolean) => void;
      readonly onDispatch: (command: ManagedControlCommand) => Promise<CommandReceipt>;
      readonly hasDraft?: (thread: ManagedControlThread) => boolean;
    },
  ) {
    this.#snapshot = options.snapshot;
    this.#settings = options.settings ?? defaultAgentUiSettings;
    this.#settingsOpen = options.initialView === "settings";
    this.#history = options.initialView === "history";
    this.select(this.rows()[0]);
  }
  private select(thread: ManagedControlThread | undefined): void {
    this.#selected = thread === undefined ? undefined : this.key(thread);
  }
  private key(thread: ManagedControlThread): string {
    return this.#history ? thread.turn.turnId : thread.threadId;
  }
  private rows(): readonly ManagedControlThread[] {
    return this.#history
      ? this.#snapshot.threads.flatMap((thread) =>
          [...(thread.previousTurns ?? []), thread.turn].map((turn) => ({
            ...thread,
            turn,
            actions: [],
          })),
        )
      : this.#snapshot.threads;
  }
  setSnapshot(snapshot: ManagedWorkspaceSnapshot, settings?: AgentUiSettings): void {
    this.#snapshot = snapshot;
    if (settings !== undefined) this.#settings = settings;
    if (!this.rows().some((thread) => this.key(thread) === this.#selected))
      this.select(this.rows()[0]);
  }
  openDetails(thread: ManagedControlThread): boolean {
    const selected = this.rows().find(
      (entry) => entry.threadId === thread.threadId && entry.turn.turnId === thread.turn.turnId,
    );
    if (selected === undefined) return false;
    this.select(selected);
    this.#detail = true;
    this.#detailScroll = 0;
    this.#help = false;
    this.#settingsOpen = false;
    this.#armed = undefined;
    this.#closeTarget = undefined;
    this.#resumeTargets = undefined;
    this.options.onChange();
    return true;
  }
  back(): void {
    this.#armed = undefined;
    this.#closeTarget = undefined;
    if (this.#help) this.#help = false;
    else if (this.#settingsOpen && this.options.initialView !== "settings")
      this.#settingsOpen = false;
    else if (this.#detail) this.#detail = false;
    else this.options.onClose();
    this.options.onChange();
  }
  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    const wheel = focusedWheelDirection(data);
    if (wheel !== null) data = wheel < 0 ? "\u001b[A" : "\u001b[B";
    if (!isKeyRepeat(data)) {
      if (!matchesKey(data, "x")) this.#armed = undefined;
      if (!matchesKey(data, "c")) this.#closeTarget = undefined;
      if (!matchesKey(data, "u") && !matchesKey(data, "shift+u")) this.#resumeTargets = undefined;
    }
    if (matchesKey(data, "escape")) {
      if (!isKeyRepeat(data)) this.back();
      return;
    }
    if (this.#help) {
      if (matchesKey(data, "?") && !isKeyRepeat(data)) this.#help = false;
      else if (matchesKey(data, "home")) this.#helpScroll = 0;
      else if (matchesKey(data, "end")) this.#helpScroll = this.#helpMaximumScroll;
      else if (matchesKey(data, "up") || matchesKey(data, "pageUp"))
        this.#helpScroll = Math.max(
          0,
          this.#helpScroll -
            (matchesKey(data, "up") ? 1 : Math.max(1, this.options.maximumLines() - 2)),
        );
      else if (matchesKey(data, "down") || matchesKey(data, "pageDown"))
        this.#helpScroll = Math.min(
          this.#helpMaximumScroll,
          this.#helpScroll +
            (matchesKey(data, "down") ? 1 : Math.max(1, this.options.maximumLines() - 2)),
        );
      this.options.onChange();
      return;
    }
    if (matchesKey(data, "?") && !isKeyRepeat(data)) {
      this.#help = true;
      this.#helpScroll = 0;
      this.options.onChange();
      return;
    }
    if (this.#settingsOpen) {
      if (this.#pending) return;
      if (matchesKey(data, "down")) this.#settingIndex = Math.min(5, this.#settingIndex + 1);
      else if (matchesKey(data, "up")) this.#settingIndex = Math.max(0, this.#settingIndex - 1);
      else if (matchesKey(data, "home")) this.#settingIndex = 0;
      else if (matchesKey(data, "end")) this.#settingIndex = 5;
      else if (
        matchesKey(data, "enter") &&
        !isKeyRepeat(data) &&
        this.#visibleSettings.has(this.#settingIndex)
      ) {
        const current = this.#settings;
        const setting = this.#settingIndex;
        const updated: AgentUiSettings | null =
          setting === 5
            ? null
            : {
                ...current,
                ...(setting === 0
                  ? {
                      widgetMode:
                        current.widgetMode === "background"
                          ? "all"
                          : current.widgetMode === "all"
                            ? "off"
                            : "background",
                    }
                  : {}),
                ...(setting === 1 ? { fleetEnabled: !current.fleetEnabled } : {}),
                ...(setting === 2 ? { showModel: !current.showModel } : {}),
                ...(setting === 3
                  ? {
                      viewerMode: nextAgentViewerMode(current.viewerMode),
                    }
                  : {}),
                ...(setting === 4
                  ? { mentions: current.mentions === "direct" ? "off" : "direct" }
                  : {}),
              };
        this.#pending = true;
        void this.options
          .onSettings(updated)
          .then(
            (receipt) => {
              if (receipt.status === "rejected") this.#notice = receipt.message;
              else {
                this.#settings = updated ?? defaultAgentUiSettings;
                this.#notice = updated === null ? "Defaults restored" : "Settings saved";
              }
            },
            () => {
              this.#notice = "Settings could not be saved.";
            },
          )
          .finally(() => {
            this.#pending = false;
            this.options.onChange();
          });
      }
      this.options.onChange();
      return;
    }
    if (matchesKey(data, "t") && !isKeyRepeat(data)) {
      this.options.onTypes?.();
      return;
    }
    if (matchesKey(data, "s") && !isKeyRepeat(data)) {
      this.#settingsOpen = true;
      this.#notice = "";
      this.options.onChange();
      return;
    }
    if (matchesKey(data, "a") && !isKeyRepeat(data)) {
      this.options.onAttention();
      return;
    }
    if (matchesKey(data, "h") && !isKeyRepeat(data)) {
      this.#history = !this.#history;
      this.#detail = false;
      this.#notice = "";
      this.#armed = undefined;
      this.#closeTarget = undefined;
      this.select(this.rows()[0]);
      this.options.onChange();
      return;
    }
    const threads = this.rows();
    const index = threads.findIndex((thread) => this.key(thread) === this.#selected);
    const selected = threads[index];
    if (matchesKey(data, "d") && !isKeyRepeat(data)) {
      if (selected !== undefined && (this.#detail || this.#visibleIds.has(this.key(selected))))
        this.openDetails(selected);
      return;
    }
    if (!matchesKey(data, "u") && !matchesKey(data, "shift+u")) this.#resumeTargets = undefined;
    if (
      (matchesKey(data, "u") || matchesKey(data, "shift+u")) &&
      !isKeyRepeat(data) &&
      !this.#pending &&
      !this.#history
    ) {
      if (this.#resumeTargets !== undefined && matchesKey(data, "u")) {
        const targets = this.#resumeTargets;
        this.#resumeTargets = undefined;
        if (
          targets.some(
            (target) =>
              !threads.some(
                (thread) =>
                  thread.threadId === target.threadId &&
                  thread.turn.turnId === target.expectedTurnId &&
                  (thread.actions?.includes("resume") || thread.actions?.includes("recover")),
              ),
          )
        ) {
          this.#notice = "The selected work changed. Select it again.";
          this.options.onChange();
          return;
        }
        this.#pending = true;
        void this.options
          .onDispatch({
            type: "resume_agents",
            parentSessionId: this.#snapshot.parentSessionId,
            targets,
          })
          .then(
            (receipt) => {
              const failure =
                receipt.status === "rejected"
                  ? receipt
                  : receipt.control?.status === "resumed"
                    ? receipt.control.results.find((result) => result.status === "rejected")
                    : undefined;
              this.#notice =
                failure?.status === "rejected" ? failure.message : `Resumed ${targets.length}`;
            },
            () => {
              this.#notice = "Resume could not be confirmed. Inspect durable state.";
            },
          )
          .finally(() => {
            this.#pending = false;
            this.options.onChange();
          });
      } else {
        const candidates = matchesKey(data, "shift+u")
          ? threads
          : selected === undefined || !this.#visibleIds.has(this.key(selected))
            ? []
            : [selected];
        const targets = candidates
          .filter(
            (thread) => thread.actions?.includes("resume") || thread.actions?.includes("recover"),
          )
          .map((thread) => ({ threadId: thread.threadId, expectedTurnId: thread.turn.turnId }));
        this.#resumeTargets = targets.length === 0 ? undefined : targets;
        this.#notice =
          targets.length === 0
            ? "No selected work can resume safely. Inspect or cancel it."
            : `u again to resume ${targets.length} exact turn${targets.length === 1 ? "" : "s"} · any other key disarms`;
      }
      this.options.onChange();
      return;
    }
    if (!matchesKey(data, "c")) this.#closeTarget = undefined;
    if (
      matchesKey(data, "c") &&
      !isKeyRepeat(data) &&
      !this.#pending &&
      selected?.actions?.includes("close") &&
      this.#visibleIds.has(this.key(selected))
    ) {
      if (
        this.#closeTarget?.threadId !== selected.threadId ||
        this.#closeTarget.turnId !== selected.turn.turnId
      ) {
        this.#closeTarget = { threadId: selected.threadId, turnId: selected.turn.turnId };
        this.#notice = "c again to close the exact thread · history retained";
      } else {
        this.#closeTarget = undefined;
        this.#pending = true;
        void this.options
          .onDispatch({
            type: "close_thread",
            parentSessionId: selected.parentSessionId,
            threadId: selected.threadId,
            expectedTurnId: selected.turn.turnId,
          })
          .then(
            (receipt) => {
              this.#notice =
                receipt.status === "rejected" ? receipt.message : "Closed · history retained";
            },
            () => {
              this.#notice = "Close could not be confirmed.";
            },
          )
          .finally(() => {
            this.#pending = false;
            this.options.onChange();
          });
      }
      this.options.onChange();
      return;
    }
    if (matchesKey(data, "x")) {
      if (
        isKeyRepeat(data) ||
        this.#pending ||
        selected === undefined ||
        !selected.actions?.includes("cancel") ||
        (!this.#detail && !this.#visibleIds.has(this.key(selected)))
      )
        return;
      if (
        this.#armed?.threadId === selected.threadId &&
        this.#armed.turnId === selected.turn.turnId
      ) {
        this.#armed = undefined;
        this.#pending = true;
        this.#notice = "Cancelling the exact turn…";
        void this.options
          .onDispatch({
            type: "cancel_turn",
            parentSessionId: selected.parentSessionId,
            threadId: selected.threadId,
            expectedTurnId: selected.turn.turnId,
          })
          .then(
            (receipt) => {
              this.#notice = receipt.status === "rejected" ? receipt.message : "Cancelled";
            },
            () => {
              this.#notice = "Cancellation could not be confirmed. Inspect durable state.";
            },
          )
          .finally(() => {
            this.#pending = false;
            this.options.onChange();
          });
      } else this.#armed = { threadId: selected.threadId, turnId: selected.turn.turnId };
      this.options.onChange();
      return;
    }
    this.#armed = undefined;
    if (this.#detail) {
      if (
        matchesKey(data, "enter") &&
        !isKeyRepeat(data) &&
        selected !== undefined &&
        (selected.turn.hasStarted || selected.turn.outcome !== undefined)
      )
        this.options.onOpen(
          selected,
          this.#history || selected.lifecycle === "closed" || !selected.turn.hasStarted,
        );
      else if (matchesKey(data, "home")) this.#detailScroll = 0;
      else if (matchesKey(data, "end")) this.#detailScroll = this.#detailMaximumScroll;
      else if (matchesKey(data, "up") || matchesKey(data, "pageUp"))
        this.#detailScroll = Math.max(
          0,
          this.#detailScroll -
            (matchesKey(data, "up") ? 1 : Math.max(1, this.options.maximumLines() - 3)),
        );
      else if (matchesKey(data, "down") || matchesKey(data, "pageDown"))
        this.#detailScroll = Math.min(
          this.#detailMaximumScroll,
          this.#detailScroll +
            (matchesKey(data, "down") ? 1 : Math.max(1, this.options.maximumLines() - 3)),
        );
    } else {
      if (matchesKey(data, "down")) this.select(threads[Math.min(threads.length - 1, index + 1)]);
      else if (matchesKey(data, "up")) this.select(threads[Math.max(0, index - 1)]);
      else if (matchesKey(data, "home")) this.select(threads[0]);
      else if (matchesKey(data, "end")) this.select(threads.at(-1));
      else if (
        matchesKey(data, "enter") &&
        !isKeyRepeat(data) &&
        selected !== undefined &&
        this.#visibleIds.has(this.key(selected))
      ) {
        if (selected.turn.hasStarted)
          this.options.onOpen(selected, this.#history || selected.lifecycle === "closed");
        else {
          this.#detail = true;
          this.#detailScroll = 0;
        }
      }
    }
    this.options.onChange();
  }
  invalidate(): void {}
  render(width: number): string[] {
    if (this.#help) {
      const lines = [
        "↑↓ / wheel select · Enter conversation or queued overview",
        "d details · h history · t types · s settings · a attention",
        "x x cancel · c c close · u u resume · U then u resume all",
        "Esc returns to the previous view",
      ].flatMap((line) => wrapTextWithAnsi(line, width));
      const height = Math.max(1, this.options.maximumLines() - 2);
      this.#helpMaximumScroll = Math.max(0, lines.length - height);
      this.#helpScroll = Math.min(this.#helpScroll, this.#helpMaximumScroll);
      return [
        this.options.theme.toolTitle("Agents help"),
        ...lines.slice(this.#helpScroll, this.#helpScroll + height),
        this.options.theme.muted("↑↓ / wheel scroll · Esc back"),
      ].map((line) => truncateToWidth(line, width));
    }
    if (this.#settingsOpen) {
      const settings = this.#settings;
      const entries = [
        `Widget · ${settings.widgetMode}`,
        `Fleet · ${settings.fleetEnabled ? "enabled" : "disabled"}`,
        `Model/thinking · ${settings.showModel ? "shown" : "hidden"}`,
        `Viewer · ${settings.viewerMode === "raw" ? "raw" : `${settings.viewerMode} Markdown`}`,
        `Mentions · ${settings.mentions}`,
        "Reset defaults",
      ];
      const maximum = Math.max(1, this.options.maximumLines() - 3);
      const start = Math.max(0, this.#settingIndex - maximum + 1);
      this.#visibleSettings = new Set(
        entries.slice(start, start + maximum).map((_, index) => start + index),
      );
      return [
        this.options.theme.toolTitle("Agent settings"),
        ...entries
          .slice(start, start + maximum)
          .map((entry, index) =>
            agentSelectionRow(
              this.options.theme,
              this.options.theme.text(entry),
              start + index === this.#settingIndex,
              width,
            ),
          ),
        this.options.theme.muted(
          this.#pending ? "Saving…" : this.#notice || "User-local display preferences",
        ),
        this.options.theme.muted(
          `↑↓ select · Enter change · Esc close${entries.length > maximum ? ` · ${entries.length - Math.min(maximum, entries.length)} hidden` : ""}`,
        ),
      ].map((line) => truncateToWidth(line, width));
    }
    const thread = this.rows().find((entry) => this.key(entry) === this.#selected);
    const lines: string[] = [];
    if (this.#detail && thread !== undefined) {
      const config = thread.turn.configuration;
      const budget = thread.budget;
      lines.push(
        agentHeading(this.options.theme, "Agent details", thread),
        this.options.theme.text(safeTerminalText(thread.description)),
        `${agentStatus(this.options.theme, thread)}${this.options.theme.muted(agentElapsedLabel(thread))}`,
      );
      if (config !== undefined)
        lines.push(
          this.options.theme.muted(
            `${safeTerminalText(config.targetId)} · thinking ${safeTerminalText(config.thinking)}`,
          ),
          this.options.theme.muted(`${config.contextWindowTokens ?? "unknown"} context tokens`),
        );
      if (budget !== undefined)
        lines.push(
          `${budget.knownUsed} used · ${budget.outstandingReserved} reserved`,
          `${budget.unknownReserved} unknown · ${budget.available === null ? "no cumulative budget" : `${budget.available} available`}`,
        );
      if (thread.turn.diagnostic !== undefined)
        lines.push(this.options.theme.statusWarning(safeTerminalText(thread.turn.diagnostic)));
      if (thread.turn.attention?.question !== undefined)
        lines.push(
          this.options.theme.statusWarning(safeTerminalText(thread.turn.attention.question)),
        );
      if (thread.turn.outcome !== undefined) {
        if (!thread.turn.hasStarted) lines.push("No agent session was started.");
        lines.push(this.options.theme.text(safeTerminalText(thread.turn.outcome.summary)));
      }
      lines.push(
        `Role: ${thread.role}`,
        `Turn: ${thread.turn.turnId}`,
        `Attempt: ${thread.turn.attemptId}`,
        ...(config === undefined ? [] : [`Configuration: ${config.digest}`]),
        `Thread: ${thread.threadId}`,
      );
      if (!thread.turn.hasStarted && thread.turn.outcome === undefined)
        lines.push(
          ...wrapTextWithAnsi(
            "Queued tasks are immutable. Cancel and start a new agent to change the task.",
            width,
          ),
        );
      const title = lines.shift() ?? "Agent detail";
      const details = lines.flatMap((line) => wrapTextWithAnsi(line, width));
      const height = Math.max(
        1,
        this.options.maximumLines() -
          3 -
          Number(this.#armed !== undefined || Boolean(this.#notice)),
      );
      this.#detailMaximumScroll = Math.max(0, details.length - height);
      this.#detailScroll = Math.min(this.#detailScroll, this.#detailMaximumScroll);
      lines.splice(
        0,
        lines.length,
        title,
        this.options.theme.muted(
          `↑↓ detail · ${Math.max(0, details.length - height)} lines hidden`,
        ),
        ...details.slice(this.#detailScroll, this.#detailScroll + height),
        `${thread.turn.hasStarted ? "Enter conversation · " : thread.turn.outcome !== undefined ? "Enter result / export · " : ""}${thread.actions?.includes("cancel") ? "x x cancel · " : ""}Esc list`,
      );
    } else {
      const threads = this.rows();
      const resumable =
        !this.#history &&
        threads.some(
          (entry) => entry.actions?.includes("resume") || entry.actions?.includes("recover"),
        );
      const controls = [
        ...(thread?.actions?.includes("close") ? ["c close"] : []),
        ...(thread?.actions?.includes("cancel") ? ["x x cancel"] : []),
        ...(resumable
          ? [
              thread?.actions?.some((action) => action === "resume" || action === "recover")
                ? "u/U resume"
                : "U resume all",
            ]
          : []),
      ].join(" · ");
      const hints = [
        width < 72
          ? "Enter open · d details · ? help · Esc"
          : "Enter open · d details · h history · t types · s settings · ? help · Esc back",
        ...(controls ? [controls] : []),
      ];
      const separated = this.options.maximumLines() >= 12;
      const maximum = Math.max(
        1,
        this.options.maximumLines() -
          2 -
          (separated ? 2 : 0) -
          hints.length -
          Number(this.#armed !== undefined || Boolean(this.#notice)),
      );
      const selectedIndex = Math.max(
        0,
        threads.findIndex((entry) => this.key(entry) === this.#selected),
      );
      const start = Math.max(0, selectedIndex - maximum + 1);
      const visible = threads.slice(start, start + maximum);
      this.#visibleIds = new Set(visible.map((entry) => this.key(entry)));
      lines.push(
        this.options.theme.toolTitle(
          `${this.#history ? "Agents history" : "Agents workspace"} · ${threads.length} ${this.#history ? "turns" : "threads"}`,
        ),
      );
      if (separated) lines.push("");
      lines.push(
        ...visible.map((entry) =>
          agentSelectionRow(
            this.options.theme,
            agentTimedLine(
              this.options.theme,
              `${this.options.theme.reference(safeTerminalText(entry.handle))} · ${agentStatus(this.options.theme, entry)}${width >= 72 ? ` · ${this.options.theme.muted(safeTerminalText(entry.displayName))}` : ""} · ${this.options.theme.text(safeTerminalText(entry.description))}${entry.lifecycle === "closed" ? this.options.theme.muted(" · Closed") : ""}${this.options.hasDraft?.(entry) ? this.options.theme.muted(` · Draft to ${entry.handle}`) : ""}`,
              entry,
              Math.max(0, width - 2),
            ),
            this.key(entry) === this.#selected,
            width,
          ),
        ),
      );
      if (start > 0 || start + visible.length < threads.length)
        lines.push(
          this.options.theme.muted(
            `${start} above · ${threads.length - start - visible.length} below`,
          ),
        );
      if (threads.length === 0)
        lines.push(
          this.options.theme.muted(
            safeTerminalText(this.#snapshot.diagnostic ?? "No agents in this Session."),
          ),
        );
      if (separated) lines.push("");
      lines.push(...hints.map(this.options.theme.muted));
    }
    if (this.#armed !== undefined)
      lines.push(
        this.options.theme.statusWarning(
          "x again to cancel the exact turn · any other key disarms",
        ),
      );
    else if (this.#notice)
      lines.push(this.options.theme.statusInfo(safeTerminalText(this.#notice)));
    return lines.map((line) => truncateToWidth(line, width));
  }
}

export class AgentSessionTransition implements Component {
  readonly #list: SelectList;
  #pending: "wait" | "suspend" | undefined;
  #notice = "";
  constructor(
    private readonly options: {
      readonly transition: ManagedSessionTransition;
      readonly theme: AdamTuiTheme;
      readonly onDecision: (decision: "stay" | "wait" | "suspend") => void;
    },
  ) {
    this.#list = new SelectList(
      [
        { value: "stay", label: "Stay" },
        { value: "wait", label: "Wait then switch" },
        { value: "suspend", label: "Suspend queued; stop running" },
      ],
      3,
      options.theme.editor.selectList,
    );
    this.#list.onSelect = (item) => options.onDecision(item.value as "stay" | "wait" | "suspend");
    this.#list.onCancel = () => this.cancel();
  }
  cancel(): void {
    this.options.onDecision("stay");
  }
  setPending(decision: "stay" | "wait" | "suspend"): void {
    this.#pending = decision === "stay" ? undefined : decision;
  }
  setError(message: string): void {
    this.#pending = undefined;
    this.#notice = safeTerminalText(message);
  }
  handleInput(data: string): void {
    if (isKeyRelease(data) || (matchesKey(data, "enter") && isKeyRepeat(data))) return;
    if (this.#pending !== undefined) {
      if (matchesKey(data, "escape") && !isKeyRepeat(data)) this.cancel();
      return;
    }
    this.#list.handleInput(data);
  }
  invalidate(): void {
    this.#list.invalidate();
  }
  render(width: number): string[] {
    return [
      this.options.theme.toolTitle("Switch Session"),
      `${this.options.transition.runningCount} running · ${this.options.transition.queuedCount} queued`,
      ...(this.#pending === undefined
        ? this.#list.render(width)
        : [
            this.#pending === "wait"
              ? "Waiting for agent work before switching…"
              : "Suspending queued and settling running agents…",
          ]),
      ...(this.#notice ? wrapTextWithAnsi(this.#notice, width) : []),
      this.options.theme.muted("Enter choose · Esc stay"),
    ].map((line) => truncateToWidth(line, width));
  }
}
