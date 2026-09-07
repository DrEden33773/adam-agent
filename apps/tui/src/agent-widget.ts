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
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import {
  type DeadlineHandle,
  type DeadlineScheduler,
  nodeDeadlineScheduler,
} from "./exit-policy.js";
import { safeTerminalText } from "./safe-terminal-text.js";
import type { AdamTuiTheme } from "./theme.js";

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
      this.options.onChange?.();
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
      (!thread.turn.hasStarted && thread.turn.phase === "waiting");
    const running = threads.filter(
      (thread) => thread.turn.phase !== "idle" && !isQueuedThread(thread),
    );
    const queued = threads.filter(isQueuedThread);
    const renderThread = (thread: (typeof threads)[number]): string[] => {
      const activity = this.#activity.find(
        (item) => item.agentId === thread.threadId && item.attemptId === thread.turn.attemptId,
      );
      const config = thread.turn.configuration;
      const budget = thread.budget;
      const isQueued = isQueuedThread(thread);
      const elapsed = agentElapsedLabel(thread);
      const content =
        (activity?.tool?.status === "generating_arguments"
          ? `Generating arguments · ${activity.tool.name}`
          : activity?.tool?.name) ??
        activity?.assistant?.text.split("\n").find((line) => line.trim().length > 0) ??
        (activity?.reasoning ? "Thinking…" : thread.turn.label);
      return [
        `├─ ${isQueued ? `${thread.turn.label.split(" · ")[0]} ${thread.handle} · ` : thread.turn.phase === "executing" ? `${["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][this.#frame]} ` : ""}${this.theme.reference(safeTerminalText(thread.displayName))} · ${thread.turn.phase === "idle" ? `${thread.turn.label} · ` : ""}${safeTerminalText(thread.description)}${elapsed}${thread.turn.phase === "idle" ? `${budget === undefined ? "" : ` · ${budget.knownUsed} used${budget.unknownReserved > 0 ? ` · ${budget.unknownReserved} unknown reserved` : ""}`}` : ""}`,
        ...(!isQueued && thread.turn.phase !== "idle"
          ? [
              `   ⎿ ${safeTerminalText(content)}${budget === undefined ? "" : ` · ${budget.knownUsed} used · ${budget.outstandingReserved} reserved${budget.unknownReserved ? ` · ${budget.unknownReserved} unknown` : ""}`}`,
            ]
          : []),
        ...((isQueued || settings?.showModel) && config !== undefined
          ? [
              `   ${safeTerminalText(config.targetId)} · thinking ${safeTerminalText(config.thinking)}`,
            ]
          : []),
        ...(isQueued && budget !== undefined
          ? [
              `   ${budget.knownUsed} used · ${budget.outstandingReserved} reserved · ${budget.unknownReserved} unknown · ${budget.available} available`,
            ]
          : []),
      ];
    };
    const maximum = Math.max(2, this.maximumLines());
    const normal = [...finished, ...running, ...queued].flatMap(renderThread);
    const lines = [
      this.theme.primary(
        `● Agents${normal.length + 1 > maximum ? ` · ${running.length} running · ${queued.length} queued` : ""}`,
      ),
    ];
    if (normal.length + 1 <= maximum) lines.push(...normal);
    else {
      const showQueueSummary = queued.length > 0 && maximum > 2;
      let budget = maximum - 2 - Number(showQueueSummary);
      let hiddenRunning = 0;
      let hiddenFinished = 0;
      let hiddenDetails = 0;
      for (const thread of running) {
        if (budget === 0) {
          hiddenRunning += 1;
          continue;
        }
        const full = renderThread(thread);
        const rendered = full.slice(0, budget);
        lines.push(...rendered);
        budget -= rendered.length;
        hiddenDetails += full.length - rendered.length;
      }
      if (showQueueSummary) lines.push(`├─ ${queued.length} queued · /agents`);
      for (const thread of finished) {
        if (budget === 0) {
          hiddenFinished += 1;
          continue;
        }
        const full = renderThread(thread);
        const rendered = full.slice(0, budget);
        lines.push(...rendered);
        budget -= rendered.length;
        hiddenDetails += full.length - rendered.length;
      }
      const compact = width < 60;
      const hidden = [
        ...(hiddenRunning ? [`${hiddenRunning} ${compact ? "run" : "running"}`] : []),
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
