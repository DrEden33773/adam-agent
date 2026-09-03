/**
 * The compact glyph, completed-linger, and completed-first overflow hierarchy selectively adapt
 * @juicesharp/rpiv-todo 2.9.0 at f3291e1ea14729d42aafd5f0f713e63c813e1f2e (MIT).
 * Adam Todo identity, state, revision, dependency, persistence, and mutation semantics are not adapted.
 * See THIRD_PARTY_NOTICES.md.
 */
import type { ActiveSessionDisplay, TodoPageResource } from "@adam-agent/presentation";

type TodoSummary = NonNullable<ActiveSessionDisplay["todo"]>;
type TodoItem = TodoPageResource["items"][number];

export interface TodoCompactRow {
  readonly blocked: boolean;
  readonly glyph: "✓" | "◐" | "○";
  readonly title: string;
}

export type TodoCompactSnapshot =
  | { readonly visible: false; readonly collapsed: boolean }
  | {
      readonly visible: true;
      readonly blockedCount: number;
      readonly collapsed: boolean;
      readonly hiddenCompleted: number;
      readonly hiddenUnfinished: number;
      readonly rows: readonly TodoCompactRow[];
      readonly unfinishedCount: number;
    };

export class TodoCompactViewModel {
  #collapsed = false;
  #items: readonly TodoItem[] = [];
  readonly #lingeringCompleted = new Map<string, TodoItem>();
  #previousUnfinished = new Map<string, TodoItem>();
  #sessionId: string | null = null;
  #summary: TodoSummary | null = null;
  #turnKey: string | null = null;

  get collapsed(): boolean {
    return this.#collapsed;
  }

  advanceTurn(sessionId: string, turnKey: string): void {
    if (this.#sessionId !== sessionId) {
      this.#sessionId = sessionId;
      this.#turnKey = turnKey;
      this.#collapsed = false;
      this.#items = [];
      this.#summary = null;
      this.#lingeringCompleted.clear();
      this.#previousUnfinished.clear();
    } else if (this.#turnKey !== turnKey) {
      this.#turnKey = turnKey;
      this.#lingeringCompleted.clear();
    }
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
    this.#lingeringCompleted.clear();
    this.#previousUnfinished.clear();
  }

  setState(input: {
    readonly items: readonly TodoItem[];
    readonly sessionId: string;
    readonly summary: TodoSummary;
    readonly turnKey: string;
  }): void {
    this.advanceTurn(input.sessionId, input.turnKey);
    const currentIds = new Set(input.items.map((item) => item.id));
    const unfinishedCount = input.summary.counts.pending + input.summary.counts.inProgress;
    const completeUnfinishedProjection = input.items.length === unfinishedCount;
    if (!completeUnfinishedProjection) {
      this.#lingeringCompleted.clear();
    } else {
      for (const [id, item] of this.#previousUnfinished) {
        if (!currentIds.has(id)) {
          this.#lingeringCompleted.set(id, { ...item, status: "completed" });
        }
      }
    }
    for (const id of currentIds) {
      this.#lingeringCompleted.delete(id);
    }
    this.#items = [...input.items].sort(todoRowOrder);
    this.#previousUnfinished = new Map(this.#items.map((item) => [item.id, item]));
    this.#summary = input.summary;
  }

  snapshot(): TodoCompactSnapshot {
    const summary = this.#summary;
    if (summary === null) {
      return { visible: false, collapsed: this.#collapsed };
    }
    const unfinishedCount = summary.counts.pending + summary.counts.inProgress;
    if (unfinishedCount === 0) {
      return { visible: false, collapsed: this.#collapsed };
    }
    if (this.#collapsed) {
      return {
        visible: true,
        blockedCount: summary.blockedCount,
        collapsed: true,
        hiddenCompleted: this.#lingeringCompleted.size,
        hiddenUnfinished: unfinishedCount,
        rows: [],
        unfinishedCount,
      };
    }
    const unfinished = this.#items.filter((item) => item.status !== "completed");
    const completed = [...this.#lingeringCompleted.values()].sort(todoRowOrder);
    const visibleUnfinished = unfinished.slice(0, 3);
    const visibleCompleted = completed.slice(0, 3 - visibleUnfinished.length);
    return {
      visible: true,
      blockedCount: summary.blockedCount,
      collapsed: false,
      hiddenCompleted: Math.max(0, completed.length - visibleCompleted.length),
      hiddenUnfinished: Math.max(0, unfinishedCount - visibleUnfinished.length),
      rows: [...visibleUnfinished, ...visibleCompleted].map((item) => ({
        blocked: item.blocked,
        glyph: item.status === "completed" ? "✓" : item.status === "in_progress" ? "◐" : "○",
        title: item.title,
      })),
      unfinishedCount,
    };
  }
}

function todoRowOrder(left: TodoItem, right: TodoItem): number {
  const leftRank = left.status === "in_progress" ? 0 : left.status === "pending" ? 1 : 2;
  const rightRank = right.status === "in_progress" ? 0 : right.status === "pending" ? 1 : 2;
  return (
    leftRank - rightRank ||
    left.createdOrdinal - right.createdOrdinal ||
    left.id.localeCompare(right.id)
  );
}
