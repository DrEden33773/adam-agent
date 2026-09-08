/**
 * The compact glyph, completed-linger, and completed-first overflow hierarchy selectively adapt
 * @juicesharp/rpiv-todo 2.9.0 at f3291e1ea14729d42aafd5f0f713e63c813e1f2e (MIT).
 * Adam Todo identity, state, revision, dependency, persistence, and mutation semantics are not adapted.
 * See THIRD_PARTY_NOTICES.md.
 */
import type { ActiveSessionDisplay, TodoPageResource } from "@adam-agent/presentation";

type TodoSummary = NonNullable<ActiveSessionDisplay["todo"]>;
type TodoItem = TodoPageResource["items"][number] & {
  readonly activeForm?: string;
  readonly dependencies?: readonly string[];
  readonly dependencyLabels?: readonly string[];
  readonly label?: string;
};

export interface TodoCompactRow {
  readonly id: string;
  readonly label: string;
  readonly dependencyLabels: readonly string[];
  readonly blocked: boolean;
  readonly glyph: "✓" | "◐" | "○";
  readonly title: string;
  readonly activeForm?: string;
  readonly dependencies: readonly string[];
}

export type TodoCompactSnapshot =
  | { readonly visible: false; readonly collapsed: boolean }
  | {
      readonly visible: true;
      readonly blockedCount: number;
      readonly collapsed: boolean;
      readonly completedCount: number;
      readonly totalCount: number;
      readonly hiddenCompleted: number;
      readonly hiddenUnfinished: number;
      readonly rows: readonly TodoCompactRow[];
      readonly unfinishedCount: number;
    };

export class TodoCompactViewModel {
  #collapsed = false;
  #items: readonly TodoItem[] = [];
  #sessionId: string | null = null;
  #summary: TodoSummary | null = null;

  clear(): void {
    this.#summary = null;
    this.#items = [];
    this.#sessionId = null;
  }

  get collapsed(): boolean {
    return this.#collapsed;
  }

  advanceTurn(sessionId: string, _turnKey: string): void {
    if (this.#sessionId === sessionId) return;
    this.#sessionId = sessionId;
    this.#collapsed = false;
    this.#items = [];
    this.#summary = null;
  }

  setCollapsed(collapsed: boolean): void {
    this.#collapsed = collapsed;
  }

  setUnavailable(input: {
    readonly sessionId: string;
    readonly summary: TodoSummary;
    readonly turnKey: string;
  }): void {
    this.advanceTurn(input.sessionId, input.turnKey);
    this.#items = [];
    this.#summary = input.summary;
  }

  setState(input: {
    readonly items: readonly TodoItem[];
    readonly sessionId: string;
    readonly summary: TodoSummary;
    readonly turnKey: string;
  }): void {
    this.advanceTurn(input.sessionId, input.turnKey);
    this.#items = [...input.items].sort(
      (left, right) =>
        left.createdOrdinal - right.createdOrdinal || left.id.localeCompare(right.id),
    );
    this.#summary = input.summary;
  }

  snapshot(maximumLines = 12): TodoCompactSnapshot {
    const summary = this.#summary;
    const completed = this.#items.filter((item) => item.status === "completed");
    const unfinishedCount = (summary?.counts.pending ?? 0) + (summary?.counts.inProgress ?? 0);
    const completedCount = summary?.overlay?.completedCount ?? completed.length;
    const totalCount = unfinishedCount + completedCount;
    if (summary === null || totalCount === 0) return { visible: false, collapsed: this.#collapsed };
    const budget = Math.min(12, Math.max(3, Math.floor(maximumLines))) - 1;
    let visible = this.#items;
    if (this.#collapsed) visible = [];
    else if (totalCount > budget) {
      const available = budget - 1;
      const unfinished = this.#items.filter((item) => item.status !== "completed");
      const kept = new Set([
        ...unfinished.slice(0, available),
        ...completed.slice(0, Math.max(0, available - unfinishedCount)),
      ]);
      visible = this.#items.filter((item) => kept.has(item));
    }
    return {
      visible: true,
      collapsed: this.#collapsed,
      blockedCount: summary.blockedCount,
      completedCount,
      totalCount,
      unfinishedCount,
      hiddenCompleted:
        completedCount - visible.filter((item) => item.status === "completed").length,
      hiddenUnfinished:
        unfinishedCount - visible.filter((item) => item.status !== "completed").length,
      rows: visible.map((item) => ({
        id: item.id,
        label: item.label ?? item.id.slice(0, 8),
        dependencyLabels: item.dependencyLabels ?? item.dependencies ?? [],
        blocked: item.blocked,
        title: item.title,
        glyph: item.status === "completed" ? "✓" : item.status === "in_progress" ? "◐" : "○",
        ...(item.status === "in_progress" && item.activeForm !== undefined
          ? { activeForm: item.activeForm }
          : {}),
        dependencies: item.dependencies ?? [],
      })),
    };
  }
}
