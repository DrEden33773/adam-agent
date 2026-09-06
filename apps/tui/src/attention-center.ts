import { randomUUID } from "node:crypto";
import type { CommandReceipt, ManagedAttentionItem } from "@adam-agent/presentation";
import {
  type Component,
  Input,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { safeTerminalText } from "./safe-terminal-text.js";
import type { AdamTuiTheme } from "./theme.js";

export function managedAttentionKey(item: ManagedAttentionItem): string {
  return `${item.parentSessionId}:${item.threadId}:${item.turnId}:${item.kind}:${item.id}`;
}

/** Local selection/focus only. Every decision goes back to the exact runtime owner. */
export class AttentionCenter implements Component {
  #items: readonly ManagedAttentionItem[] = [];
  #focusedKey: string | undefined;
  readonly #selected = new Set<string>();
  readonly #busy = new Set<string>();
  #explicitSelection = false;
  #notice = "";
  #focused = false;
  #visible = new Set<string>();
  #detailOffset = 0;
  #detailPageSize = 1;
  readonly #replyInput = new Input();
  readonly #replyDrafts = new Map<string, string>();
  #replyTarget: Extract<ManagedAttentionItem, { kind: "parent_input" }> | undefined;
  #replySending = false;
  #replySubmission:
    | { readonly key: string; readonly text: string; readonly inputId: string }
    | undefined;

  constructor(
    private readonly options: {
      readonly theme: AdamTuiTheme;
      readonly maximumLines: () => number;
      readonly onPermission: (
        item: Extract<ManagedAttentionItem, { kind: "permission" }>,
        decision: "allow" | "deny",
      ) => Promise<CommandReceipt>;
      readonly onReply: (
        item: Extract<ManagedAttentionItem, { kind: "parent_input" }>,
        text: string,
        inputId: string,
      ) => Promise<CommandReceipt>;
      readonly onChange: () => void;
      readonly onClose: () => void;
    },
  ) {
    this.#replyInput.onSubmit = (text) => {
      void this.reply(text);
    };
  }

  get focused(): boolean {
    return this.#focused;
  }
  set focused(value: boolean) {
    this.#focused = value;
    this.#replyInput.focused = value && this.#replyTarget !== undefined;
  }
  hasPendingInput(): boolean {
    return (
      this.#replySending ||
      (this.#replyTarget !== undefined && this.#replyInput.getValue().length > 0)
    );
  }
  setItems(items: readonly ManagedAttentionItem[]): void {
    const previousIndex = this.#items.findIndex(
      (item) => managedAttentionKey(item) === this.#focusedKey,
    );
    this.#items = [
      ...items.filter((item) => item.kind === "permission"),
      ...items.filter((item) => item.kind === "parent_input"),
    ];
    const keys = new Set(this.#items.map(managedAttentionKey));
    if (this.#focusedKey === undefined || !keys.has(this.#focusedKey)) {
      const next = this.#items[Math.max(0, Math.min(previousIndex, this.#items.length - 1))];
      this.#focusedKey = next === undefined ? undefined : managedAttentionKey(next);
      this.#detailOffset = 0;
    }
    for (const key of this.#selected) if (!keys.has(key)) this.#selected.delete(key);
    const focused = this.current();
    if (!this.#explicitSelection && this.#selected.size === 0 && focused?.kind === "permission")
      this.#selected.add(managedAttentionKey(focused));
  }
  private current(): ManagedAttentionItem | undefined {
    return this.#items.find((item) => managedAttentionKey(item) === this.#focusedKey);
  }
  focusItem(key: string): void {
    const item = this.#items.find((candidate) => managedAttentionKey(candidate) === key);
    if (item === undefined) return;
    if (this.#replyTarget !== undefined)
      this.#replyDrafts.set(managedAttentionKey(this.#replyTarget), this.#replyInput.getValue());
    this.#replyTarget = undefined;
    this.#replyInput.focused = false;
    this.#focusedKey = key;
    this.#detailOffset = 0;
    this.#explicitSelection = false;
    this.#selected.clear();
    if (item.kind === "permission") this.#selected.add(key);
  }
  back(): void {
    if (this.#replyTarget !== undefined) {
      this.#replyDrafts.set(managedAttentionKey(this.#replyTarget), this.#replyInput.getValue());
      this.#replyTarget = undefined;
      this.#replyInput.focused = false;
      this.#detailOffset = 0;
    } else this.options.onClose();
    this.options.onChange();
  }
  private async decide(decision: "allow" | "deny"): Promise<void> {
    const selected = this.#items.filter(
      (item): item is Extract<ManagedAttentionItem, { kind: "permission" }> =>
        item.kind === "permission" &&
        this.#selected.has(managedAttentionKey(item)) &&
        !this.#busy.has(managedAttentionKey(item)),
    );
    if (
      selected.length === 0 ||
      selected.some(
        (item) => !item.available || (decision === "allow" && !item.interaction?.canAllow),
      )
    ) {
      this.#notice = "Select exact available requests before deciding.";
      this.options.onChange();
      return;
    }
    for (const item of selected) this.#busy.add(managedAttentionKey(item));
    this.#notice = "Submitting exact permission decisions…";
    this.options.onChange();
    try {
      const receipts = await Promise.all(
        selected.map((item) => this.options.onPermission(item, decision)),
      );
      const rejected = receipts.find((receipt) => receipt.status === "rejected");
      this.#notice =
        rejected?.status === "rejected"
          ? rejected.message
          : "Decision submitted; waiting for the recorded state.";
    } catch {
      this.#notice = "Some decisions could not be confirmed. Inspect the remaining requests.";
    } finally {
      for (const item of selected) this.#busy.delete(managedAttentionKey(item));
      this.options.onChange();
    }
  }
  private async reply(text: string): Promise<void> {
    const target = this.#replyTarget;
    if (target === undefined || this.#replySending || !text.trim()) return;
    if (
      !this.#items.some(
        (item) => managedAttentionKey(item) === managedAttentionKey(target) && item.available,
      )
    ) {
      this.#notice = "This exact request is no longer pending. Your text is retained.";
      this.options.onChange();
      return;
    }
    this.#replySending = true;
    this.#notice = "Accepting the exact parent reply…";
    this.options.onChange();
    const key = managedAttentionKey(target);
    if (this.#replySubmission?.key !== key || this.#replySubmission.text !== text)
      this.#replySubmission = { key, text, inputId: randomUUID() };
    try {
      const receipt = await this.options.onReply(target, text, this.#replySubmission.inputId);
      if (receipt.status === "rejected") this.#notice = receipt.message;
      else if (receipt.control?.status === "input_accepted") {
        if (
          this.#replyTarget !== undefined &&
          managedAttentionKey(this.#replyTarget) === managedAttentionKey(target) &&
          this.#replyInput.getValue() === text
        ) {
          this.#replyInput.setValue("");
          this.#replyTarget = undefined;
          this.#replyInput.focused = false;
        }
        this.#replyDrafts.delete(managedAttentionKey(target));
        this.#replySubmission = undefined;
        this.#notice = "Reply accepted.";
      }
    } catch {
      this.#notice = "Reply acceptance could not be confirmed. Your text is retained.";
    } finally {
      this.#replySending = false;
      this.options.onChange();
    }
  }
  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (matchesKey(data, "escape")) {
      if (!isKeyRepeat(data)) this.back();
      return;
    }
    if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
      this.#detailOffset = Math.max(
        0,
        this.#detailOffset +
          (matchesKey(data, "pageUp") ? -this.#detailPageSize : this.#detailPageSize),
      );
      this.options.onChange();
      return;
    }
    if (this.#replyTarget !== undefined) {
      if (!this.#replySending && !(matchesKey(data, "enter") && isKeyRepeat(data))) {
        this.#replyInput.handleInput(data);
        if (this.#replyTarget !== undefined)
          this.#replyDrafts.set(
            managedAttentionKey(this.#replyTarget),
            this.#replyInput.getValue(),
          );
      }
      this.options.onChange();
      return;
    }
    const focused = this.current();
    if (matchesKey(data, "home") || matchesKey(data, "end")) {
      const item = matchesKey(data, "home") ? this.#items[0] : this.#items.at(-1);
      this.#focusedKey = item === undefined ? undefined : managedAttentionKey(item);
      this.#detailOffset = 0;
    } else if (matchesKey(data, "up") || matchesKey(data, "down")) {
      const index = this.#items.findIndex((item) => managedAttentionKey(item) === this.#focusedKey);
      const next =
        this.#items[
          Math.max(0, Math.min(this.#items.length - 1, index + (matchesKey(data, "up") ? -1 : 1)))
        ];
      this.#focusedKey = next === undefined ? undefined : managedAttentionKey(next);
      this.#detailOffset = 0;
    } else if (
      focused !== undefined &&
      this.#visible.has(managedAttentionKey(focused)) &&
      !isKeyRepeat(data)
    ) {
      if (focused.kind === "permission") {
        if (matchesKey(data, "space")) {
          const key = managedAttentionKey(focused);
          if (!this.#explicitSelection) {
            this.#explicitSelection = true;
            this.#selected.clear();
            this.#selected.add(key);
          } else if (!this.#selected.delete(key)) this.#selected.add(key);
        } else if (matchesKey(data, "a") || matchesKey(data, "enter")) void this.decide("allow");
        else if (matchesKey(data, "d")) void this.decide("deny");
      } else if (matchesKey(data, "enter") && focused.available && !this.#replySending) {
        this.#replyTarget = focused;
        this.#replyInput.setValue(this.#replyDrafts.get(managedAttentionKey(focused)) ?? "");
        this.#replyInput.focused = this.#focused;
        this.#notice = "";
        this.#detailOffset = 0;
      }
    }
    if (
      !this.#explicitSelection &&
      (matchesKey(data, "home") ||
        matchesKey(data, "end") ||
        matchesKey(data, "up") ||
        matchesKey(data, "down"))
    ) {
      this.#selected.clear();
      const next = this.current();
      if (next?.kind === "permission") this.#selected.add(managedAttentionKey(next));
    }
    this.options.onChange();
  }
  invalidate(): void {}
  render(width: number): string[] {
    const maximum = Math.max(6, this.options.maximumLines());
    if (this.#replyTarget !== undefined) {
      const question = wrapTextWithAnsi(safeTerminalText(this.#replyTarget.question), width);
      this.#detailPageSize = Math.max(1, maximum - 3 - Number(Boolean(this.#notice)));
      this.#detailOffset = Math.min(
        this.#detailOffset,
        Math.max(0, question.length - this.#detailPageSize),
      );
      return [
        this.options.theme.primary(`Parent input · ${this.#replyTarget.handle}`),
        ...question.slice(this.#detailOffset, this.#detailOffset + this.#detailPageSize),
        ...(this.#notice ? [safeTerminalText(this.#notice)] : []),
        ...this.#replyInput.render(width),
        "Enter reply · PgDn question · Esc list",
      ].map((line) => truncateToWidth(line, width));
    }
    const selectedIndex = Math.max(
      0,
      this.#items.findIndex((item) => managedAttentionKey(item) === this.#focusedKey),
    );
    const rowCount = Math.max(1, maximum - 7);
    const start = Math.max(0, selectedIndex - rowCount + 1);
    const visible = this.#items.slice(start, start + rowCount);
    this.#visible = new Set(visible.map(managedAttentionKey));
    const lines = [this.options.theme.primary("Attention Center")];
    for (const kind of ["permission", "parent_input"] as const) {
      const all = this.#items.filter((item) => item.kind === kind);
      const rows = visible.filter((item) => item.kind === kind);
      lines.push(
        `${kind === "permission" ? "Permissions" : "Parent input"} · ${all.length}${all.length > rows.length ? ` · ${all.length - rows.length} hidden` : ""}`,
      );
      lines.push(
        ...rows.map(
          (item) =>
            `${managedAttentionKey(item) === this.#focusedKey ? "●" : "○"} ${item.kind === "permission" ? (this.#selected.has(managedAttentionKey(item)) ? "[x] " : "[ ] ") : ""}${item.handle} · ${safeTerminalText(item.displayName)} · ${safeTerminalText(item.description)}`,
        ),
      );
    }
    const focused = this.current();
    const detail =
      focused?.kind === "permission"
        ? focused.interaction === null
          ? (focused.diagnostic ?? "Permission details unavailable.")
          : `${focused.interaction.effect} · ${focused.interaction.subject.value}`
        : (focused?.question ?? "No pending attention.");
    const details = wrapTextWithAnsi(safeTerminalText(detail), width);
    this.#detailPageSize = Math.max(0, maximum - lines.length - 1 - Number(Boolean(this.#notice)));
    this.#detailOffset = Math.min(
      this.#detailOffset,
      Math.max(0, details.length - this.#detailPageSize),
    );
    lines.push(...details.slice(this.#detailOffset, this.#detailOffset + this.#detailPageSize));
    if (this.#notice) lines.push(safeTerminalText(this.#notice));
    lines.push(
      focused?.kind === "permission"
        ? `a Allow · d Deny · Space ${this.#explicitSelection ? "toggle" : "pin"} · Esc close`
        : "Enter reply · PgDn detail · Esc close",
    );
    return lines.map((line) => truncateToWidth(line, width));
  }
}
