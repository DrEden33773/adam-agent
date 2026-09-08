/**
 * Agent tree layout adapted from tintinweb/pi-subagents src/ui/agent-widget.ts
 * at 4f572eaa04c09d3dbc16e4a5f13a16b295e84e14 (MIT). See THIRD_PARTY_NOTICES.md.
 * Adam Presentation supplies all execution truth; this component only renders it.
 */
import type {
  AgentUiSettings,
  ManagedControlThread,
  ManagedWorkspaceSnapshot,
  PresentationDisplayState,
} from "@adam-agent/presentation";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  type DeadlineHandle,
  type DeadlineScheduler,
  nodeDeadlineScheduler,
} from "./exit-policy.js";
import { safeTerminalText } from "./safe-terminal-text.js";
import type { AdamTuiTheme } from "./theme.js";
import { toolArgumentPhaseLabel } from "./tool-argument-phase.js";

export function agentElapsedLabel(thread: ManagedControlThread): string {
  const start = thread.turn.startedAtUnixMilliseconds;
  if (start === undefined) return "";
  const end =
    thread.turn.outcome === undefined
      ? thread.residency === "live"
        ? Date.now()
        : undefined
      : thread.turn.outcome.atUnixMilliseconds;
  return end === undefined
    ? " · elapsed unknown"
    : ` · elapsed ${Math.max(0, Math.floor((end - start) / 1000))}s`;
}

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
      ...(attentionCount ? [`${attentionCount} attention`] : []),
      ...(errorCount ? [`${errorCount} error${errorCount === 1 ? "" : "s"}`] : []),
    ];
    const maximum = Math.max(2, this.maximumLines());
    if (maximum === 2 && (waiting.length || settling.length || attentionCount || errorCount)) {
      return [
        this.theme.primary(
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
    const renderThread = (thread: (typeof threads)[number], compressed = false): string[] => {
      const activity = this.#activity.find(
        (item) => item.agentId === thread.threadId && item.attemptId === thread.turn.attemptId,
      );
      const config = thread.turn.configuration;
      const isQueued = isQueuedThread(thread);
      const priorityStatus =
        compressed &&
        (needsAttention(thread) ||
          hasError(thread) ||
          thread.turn.phase === "waiting" ||
          thread.turn.phase === "settling");
      const elapsed = agentElapsedLabel(thread);
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
      return [
        `├─ ${isQueued ? `${safeTerminalText(thread.turn.label.split(" · ")[0] ?? thread.turn.label)} ${safeTerminalText(thread.handle)} · ` : priorityStatus ? `${safeTerminalText(thread.turn.label)} · ` : thread.turn.phase === "executing" ? `${["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][this.#frame]} ` : ""}${this.theme.reference(safeTerminalText(thread.displayName))} · ${thread.turn.phase === "idle" && !priorityStatus ? `${safeTerminalText(thread.turn.label)} · ` : ""}${safeTerminalText(thread.description)}${elapsed}`,
        ...(!isQueued && thread.turn.phase !== "idle"
          ? [`   ⎿ ${safeTerminalText(visibleContent)}`]
          : []),
        ...(thread.turn.outcome?.error === undefined
          ? []
          : [
              `   ⎿ ${safeTerminalText(`${thread.turn.outcome.error.code}: ${thread.turn.outcome.error.message}`)}`,
            ]),
        ...(settings?.showModel && config !== undefined
          ? [
              `   ${safeTerminalText(config.targetId)} · thinking ${safeTerminalText(config.thinking)}`,
            ]
          : []),
      ];
    };
    const normal = [...finished, ...active, ...queued].flatMap((thread) => renderThread(thread));
    const statusCounts = [
      `${running.length} running`,
      ...(waiting.length ? [`${waiting.length} waiting`] : []),
      ...(settling.length ? [`${settling.length} settling`] : []),
      `${queued.length} queued`,
    ];
    const lines = [
      this.theme.primary(
        `● Agents${normal.length + 1 > maximum ? ` · ${(urgentCounts.length ? urgentCounts : statusCounts).join(" · ")}` : ""}`,
      ),
    ];
    if (normal.length + 1 <= maximum) lines.push(...normal);
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
        const full = renderThread(thread, true);
        const rendered = full.slice(0, budget);
        lines.push(...rendered);
        budget -= rendered.length;
        hiddenDetails += full.length - rendered.length;
      }
      if (showQueueSummary) lines.push(`├─ ${queued.length} queued · /agents`);
      const compact = width < 60;
      const hidden = [
        ...(hiddenRunning ? [`${hiddenRunning} ${compact ? "run" : "running"}`] : []),
        ...(hiddenWaiting ? [`${hiddenWaiting} waiting`] : []),
        ...(hiddenSettling ? [`${hiddenSettling} settling`] : []),
        ...(queued.length ? [`${queued.length} queued`] : []),
        ...(hiddenFinished ? [`${hiddenFinished} ${compact ? "done" : "finished"}`] : []),
        ...(hiddenDetails ? [`${hiddenDetails} ${compact ? "line" : "detail lines"}`] : []),
      ];
      lines.push(compact ? `… hidden ${hidden.join("/")}` : `… ${hidden.join(" / ")} hidden`);
    }
    const lastBranch = lines.findLastIndex((line) => line.includes("├─"));
    if (lastBranch >= 0) lines[lastBranch] = (lines[lastBranch] ?? "").replace("├─", "└─");
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
