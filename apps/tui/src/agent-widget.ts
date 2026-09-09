/**
 * Agent tree layout adapted from tintinweb/pi-subagents src/ui/agent-widget.ts
 * at 4f572eaa04c09d3dbc16e4a5f13a16b295e84e14 (MIT). See THIRD_PARTY_NOTICES.md.
 * Adam Presentation supplies all execution truth; this component only renders it.
 */
import type {
  AgentUiSettings,
  ManagedWorkspaceSnapshot,
  PresentationDisplayState,
} from "@adam-agent/presentation";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { agentStatus, agentStatusStyle, agentTimedLine } from "./agent-view-format.js";
import {
  type DeadlineHandle,
  type DeadlineScheduler,
  nodeDeadlineScheduler,
} from "./exit-policy.js";
import { safeTerminalText } from "./safe-terminal-text.js";
import type { AdamTuiTheme } from "./theme.js";
import { toolArgumentPhaseLabel } from "./tool-argument-phase.js";

export class AgentWidget implements Component {
  #snapshot: ManagedWorkspaceSnapshot | undefined;
  #activity: NonNullable<PresentationDisplayState["managedAgentActivity"]> = [];
  readonly #previous = new Map<string, string>();
  readonly #linger = new Map<string, DeadlineHandle>();
  readonly #expired = new Set<string>();
  #animation: DeadlineHandle | undefined;
  #frame = 0;
  #disposed = false;
  constructor(
    private readonly theme: AdamTuiTheme,
    private readonly maximumLines: () => number = () => 12,
    private readonly options: {
      readonly settings?: () => AgentUiSettings;
      readonly scheduler?: DeadlineScheduler;
      readonly onChange?: () => void;
      readonly onAnimation?: () => void;
    } = {},
  ) {}
  setSnapshot(snapshot: ManagedWorkspaceSnapshot | undefined): void {
    if (this.#snapshot?.parentSessionId !== snapshot?.parentSessionId) {
      for (const timer of this.#linger.values()) timer.cancel();
      this.#linger.clear();
      this.#expired.clear();
      this.#previous.clear();
    }
    this.#snapshot = snapshot;
    if (this.#disposed) return;
    for (const thread of snapshot?.threads ?? []) {
      const key = thread.turn.turnId;
      const before = this.#previous.get(key);
      if (thread.turn.phase === "idle" && before !== "idle" && !this.#expired.has(key)) {
        if (before === undefined) this.#expired.add(key);
        else {
          let timer: DeadlineHandle | undefined;
          timer = (this.options.scheduler ?? nodeDeadlineScheduler).schedule(4000, () => {
            timer?.cancel();
            this.#linger.delete(key);
            this.#expired.add(key);
            if (!this.#disposed) this.options.onChange?.();
          });
          this.#linger.set(key, timer);
        }
      }
      this.#previous.set(key, thread.turn.phase);
    }
    this.synchronizeAnimation();
  }
  visibleThreads(): NonNullable<ManagedWorkspaceSnapshot>["threads"] {
    return (
      this.#snapshot?.threads.filter(
        (thread) => thread.lifecycle === "open" && !this.#expired.has(thread.turn.turnId),
      ) ?? []
    );
  }
  private synchronizeAnimation(): void {
    const active = this.visibleThreads().some(
      (thread) => thread.turn.phase === "executing" || thread.turn.phase === "starting",
    );
    if (!active || this.#disposed) {
      this.#animation?.cancel();
      this.#animation = undefined;
      return;
    }
    if (this.#animation !== undefined) return;
    this.#animation = (this.options.scheduler ?? nodeDeadlineScheduler).schedule(80, () => {
      this.#animation?.cancel();
      this.#animation = undefined;
      if (this.#disposed) return;
      this.#frame = (this.#frame + 1) % 10;
      this.options.onAnimation?.();
      this.synchronizeAnimation();
    });
  }
  dispose(): void {
    this.#disposed = true;
    this.#animation?.cancel();
    this.#animation = undefined;
    for (const timer of this.#linger.values()) timer.cancel();
    this.#linger.clear();
  }
  setActivity(activity: PresentationDisplayState["managedAgentActivity"]): void {
    this.#activity = activity ?? [];
  }
  invalidate(): void {}
  render(width: number): string[] {
    const settings = this.options.settings?.();
    if (settings?.widgetMode === "off") return [];
    const threads = this.visibleThreads().filter(
      (thread) => settings?.widgetMode === "all" || thread.turn.lane !== "reserved",
    );
    if (threads.length === 0) return [];
    const finished = threads.filter((thread) => thread.turn.phase === "idle");
    const isQueuedThread = (thread: (typeof threads)[number]) =>
      thread.turn.phase === "queued" ||
      (!thread.turn.hasStarted &&
        thread.turn.phase === "waiting" &&
        (thread.turn.waitReason === "capacity" || thread.turn.waitReason === "suspended"));
    const active = threads.filter(
      (thread) => thread.turn.phase !== "idle" && !isQueuedThread(thread),
    );
    const running = active.filter(
      (thread) => thread.turn.phase === "starting" || thread.turn.phase === "executing",
    );
    const waiting = active.filter((thread) => thread.turn.phase === "waiting");
    const settling = active.filter((thread) => thread.turn.phase === "settling");
    const queued = threads.filter(isQueuedThread);
    const needsAttention = (thread: (typeof threads)[number]) =>
      thread.turn.attention !== undefined ||
      thread.turn.waitReason === "permission" ||
      thread.turn.waitReason === "parent_input" ||
      thread.turn.recovery === "required" ||
      thread.turn.health === "stalled";
    const hasError = (thread: (typeof threads)[number]) =>
      thread.turn.lastOutcome === "failed" || thread.turn.outcome?.error !== undefined;
    const attentionCount = threads.filter(needsAttention).length;
    const errorCount = threads.filter(hasError).length;
    const urgentCounts = [
      ...(attentionCount ? [this.theme.statusWarning(`${attentionCount} attention`)] : []),
      ...(errorCount
        ? [this.theme.statusError(`${errorCount} error${errorCount === 1 ? "" : "s"}`)]
        : []),
    ];
    const maximum = Math.max(2, this.maximumLines());
    if (maximum === 2 && (waiting.length || settling.length || attentionCount || errorCount)) {
      return [
        this.theme.toolTitle(
          `● Agents ${threads.length}${urgentCounts.length ? ` · ${urgentCounts.join(" · ")}` : ""}`,
        ),
        boundedCountSummary(
          [
            ...(waiting.length ? [`${waiting.length} waiting`] : []),
            ...(queued.length ? [`${queued.length} queued`] : []),
            ...(settling.length ? [`${settling.length} settling`] : []),
            ...(running.length ? [`${running.length} running`] : []),
            ...(finished.length ? [`${finished.length} finished`] : []),
          ],
          width,
        ),
      ].map((line) => truncateToWidth(line, width));
    }
    type Node = {
      readonly head: (columns: number) => string;
      readonly children: readonly string[];
    };
    const threadNode = (thread: (typeof threads)[number], compressed = false): Node => {
      const activity = this.#activity.find(
        (item) => item.agentId === thread.threadId && item.attemptId === thread.turn.attemptId,
      );
      const config = thread.turn.configuration;
      const isQueued = isQueuedThread(thread);
      const argumentPhase =
        activity?.tool === undefined ? undefined : toolArgumentPhaseLabel(activity.tool.status);
      const content =
        (argumentPhase !== undefined
          ? `${argumentPhase} · ${activity?.tool?.name}`
          : activity?.tool?.name) ??
        activity?.assistant?.text.split("\n").find((line) => line.trim().length > 0) ??
        (activity?.reasoning ? "Thinking…" : thread.turn.label);
      const visibleContent =
        (thread.turn.phase !== "executing" || thread.turn.health === "stalled") &&
        content !== thread.turn.label
          ? `${thread.turn.label} · ${content}`
          : content;
      const contentStyle =
        activity?.tool !== undefined
          ? this.theme.toolTitle
          : content === thread.turn.label
            ? agentStatusStyle(this.theme, thread)
            : this.theme.text;
      return {
        head: (columns) => {
          const spinner =
            thread.turn.phase === "executing"
              ? `${this.theme.reference(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][this.#frame] ?? "⠋")} `
              : "";
          const status =
            compressed || isQueued || thread.turn.phase === "idle" || columns < 55
              ? ` · ${agentStatus(this.theme, thread)}`
              : "";
          const role =
            columns >= 55 ? ` · ${this.theme.muted(safeTerminalText(thread.displayName))}` : "";
          return agentTimedLine(
            this.theme,
            `${spinner}${this.theme.reference(safeTerminalText(thread.handle))}${status}${role} · ${this.theme.text(safeTerminalText(thread.description))}`,
            thread,
            columns,
          );
        },
        children: [
          ...(!isQueued && thread.turn.phase !== "idle"
            ? [contentStyle(safeTerminalText(visibleContent))]
            : []),
          ...(thread.turn.outcome?.error === undefined
            ? []
            : [
                this.theme.statusError(
                  safeTerminalText(
                    `${thread.turn.outcome.error.code}: ${thread.turn.outcome.error.message}`,
                  ),
                ),
              ]),
          ...(settings?.showModel && config !== undefined
            ? [
                this.theme.muted(
                  `${safeTerminalText(config.targetId)} · thinking ${safeTerminalText(config.thinking)}`,
                ),
              ]
            : []),
        ],
      };
    };
    const normal = [...finished, ...active, ...queued].map((thread) => threadNode(thread));
    const normalHeight = normal.reduce((sum, node) => sum + 1 + node.children.length, 0);
    const statusCounts = [
      this.theme.reference(`${running.length} running`),
      ...(waiting.length ? [this.theme.statusWarning(`${waiting.length} waiting`)] : []),
      ...(settling.length ? [this.theme.reference(`${settling.length} settling`)] : []),
      this.theme.statusWarning(`${queued.length} queued`),
    ];
    const lines = [
      `${this.theme.toolTitle("● Agents")}${normalHeight + 1 > maximum ? ` · ${(urgentCounts.length ? urgentCounts : statusCounts).join(" · ")}` : ""}`,
    ];
    const visible: Node[] = [];
    let footer: string | undefined;
    if (normalHeight + 1 <= maximum) visible.push(...normal);
    else {
      const showQueueSummary = queued.length > 0 && maximum > 2;
      let budget = maximum - 2 - Number(showQueueSummary);
      let hiddenRunning = 0;
      let hiddenWaiting = 0;
      let hiddenSettling = 0;
      let hiddenFinished = 0;
      let hiddenDetails = 0;
      const priority = (thread: (typeof threads)[number]) =>
        hasError(thread) ? 2 : needsAttention(thread) ? 1 : 0;
      const ordered = [...active, ...finished].sort(
        (left, right) => priority(right) - priority(left),
      );
      for (const thread of ordered) {
        if (budget === 0) {
          if (thread.turn.phase === "waiting") hiddenWaiting += 1;
          else if (thread.turn.phase === "settling") hiddenSettling += 1;
          else if (thread.turn.phase === "idle") hiddenFinished += 1;
          else hiddenRunning += 1;
          continue;
        }
        const node = threadNode(thread, true);
        const children = node.children.slice(0, budget - 1);
        visible.push({ ...node, children });
        budget -= 1 + children.length;
        hiddenDetails += node.children.length - children.length;
      }
      if (showQueueSummary)
        visible.push({
          head: () => this.theme.statusWarning(`${queued.length} queued · /agents`),
          children: [],
        });
      const compact = width < 60;
      const hidden = [
        ...(hiddenRunning ? [`${hiddenRunning} ${compact ? "run" : "running"}`] : []),
        ...(hiddenWaiting ? [`${hiddenWaiting} waiting`] : []),
        ...(hiddenSettling ? [`${hiddenSettling} settling`] : []),
        ...(queued.length ? [`${queued.length} queued`] : []),
        ...(hiddenFinished ? [`${hiddenFinished} ${compact ? "done" : "finished"}`] : []),
        ...(hiddenDetails ? [`${hiddenDetails} ${compact ? "line" : "detail lines"}`] : []),
      ];
      footer = this.theme.muted(
        compact ? `… hidden ${hidden.join("/")}` : `… ${hidden.join(" / ")} hidden · /agents`,
      );
    }
    // The final visible structure owns connectors. Never search or rewrite rendered content.
    for (const [index, node] of visible.entries()) {
      const last = index === visible.length - 1;
      const prefix = last ? "└─ " : "├─ ";
      lines.push(this.theme.overlay(prefix) + node.head(Math.max(0, width - visibleWidth(prefix))));
      for (const [childIndex, child] of node.children.entries()) {
        const childPrefix = `${last ? "   " : "│  "}${childIndex === node.children.length - 1 ? "└─ " : "├─ "}`;
        lines.push(
          this.theme.overlay(childPrefix) +
            truncateToWidth(child, Math.max(0, width - visibleWidth(childPrefix))),
        );
      }
    }
    if (footer !== undefined) lines.push(footer);
    return lines.map((line) => truncateToWidth(line, width));
  }
}

/** Keep whole status counts; the header's total still covers any omitted categories. */
function boundedCountSummary(parts: readonly string[], width: number): string {
  for (let count = parts.length; count > 0; count -= 1) {
    const text = `${parts.slice(0, count).join(" · ")}${count < parts.length ? " · …" : ""}`;
    if (visibleWidth(text) <= width) return text;
  }
  return truncateToWidth(parts[0] ?? "", width);
}
