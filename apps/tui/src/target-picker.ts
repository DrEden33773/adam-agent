import type { TargetDisplay } from "@adam-agent/presentation";
import {
  type Component,
  fuzzyFilter,
  getKeybindings,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { adamCommandRegistry } from "./command-registry.js";
import { safeTerminalText } from "./safe-terminal-text.js";
import type { AdamTuiTheme } from "./theme.js";

export class TargetPicker implements Component {
  readonly #list: TargetSearchList;
  readonly #columns: () => number;
  readonly #maximumContentRows: () => number;
  readonly #canFork: boolean;
  readonly #currentTargetId: string | undefined;
  readonly #mode: "create" | "transition";
  readonly #onCreate: ((target: TargetDisplay) => void) | undefined;
  readonly #onCheckConnection: (target: TargetDisplay) => void;
  readonly #onFork: ((target: TargetDisplay) => void) | undefined;
  readonly #onSetDefault: (target: TargetDisplay | null) => void;
  readonly #targets: Map<string, TargetDisplay>;
  readonly #theme: AdamTuiTheme;
  #defaultTargetId: string | null;
  #detailEffectiveScrollOffset = 0;
  #detailMaximumScrollOffset = 0;
  #detailPageSize = 1;
  #detailScrollOffset = 0;
  #focus: "details" | "models" = "models";
  #notice: string | null = null;

  constructor(options: {
    readonly targets: readonly TargetDisplay[];
    readonly columns: () => number;
    readonly maximumContentRows: () => number;
    readonly canFork?: boolean;
    readonly theme: AdamTuiTheme;
    readonly initialNotice?: string;
    readonly currentTargetId?: string;
    readonly defaultTargetId: string | null;
    readonly mode?: "create" | "transition";
    readonly onClose: () => void;
    readonly onCheckConnection: (target: TargetDisplay) => void;
    readonly onCreate?: (target: TargetDisplay) => void;
    readonly onFork?: (target: TargetDisplay) => void;
    readonly onSelect: (target: TargetDisplay) => void;
    readonly onSetDefault: (target: TargetDisplay | null) => void;
  }) {
    this.#theme = options.theme;
    this.#columns = options.columns;
    this.#maximumContentRows = options.maximumContentRows;
    this.#canFork = options.canFork ?? false;
    this.#currentTargetId = options.currentTargetId;
    this.#mode = options.mode ?? "create";
    this.#onCreate = options.onCreate;
    this.#onCheckConnection = options.onCheckConnection;
    this.#onFork = options.onFork;
    this.#notice =
      options.initialNotice === undefined ? null : safeTerminalText(options.initialNotice);
    this.#defaultTargetId = options.defaultTargetId;
    this.#onSetDefault = options.onSetDefault;
    this.#targets = new Map(options.targets.map((target) => [target.targetId, target]));
    this.#list = new TargetSearchList({
      items: this.#items(),
      maxVisible: 8,
      onCancel: options.onClose,
      onSelect: (targetId) => {
        const target = this.#targets.get(targetId);
        if (target !== undefined) {
          options.onSelect(target);
        }
      },
      theme: options.theme,
    });
  }

  setNotice(notice: string): void {
    this.#notice = safeTerminalText(notice);
  }

  setDefaultTargetId(targetId: string | null): void {
    this.#defaultTargetId = targetId;
    this.#list.setItems(this.#items());
  }

  setTargets(targets: readonly TargetDisplay[], defaultTargetId: string | null): void {
    const previousTargetId = this.#list.getSelectedTargetId();
    this.#targets.clear();
    for (const target of targets) {
      this.#targets.set(target.targetId, target);
    }
    this.#defaultTargetId = defaultTargetId;
    this.#list.setItems(this.#items());
    if (this.#list.getSelectedTargetId() !== previousTargetId) {
      this.#setDetailScrollOffset(0);
    }
  }

  handleInput(data: string): void {
    if (getKeybindings().matches(data, "tui.input.tab")) {
      this.#focus = this.#focus === "models" ? "details" : "models";
      return;
    }
    if (this.#focus === "details" && getKeybindings().matches(data, "tui.select.up")) {
      this.#setDetailScrollOffset(Math.max(0, this.#detailEffectiveScrollOffset - 1));
      return;
    }
    if (this.#focus === "details" && getKeybindings().matches(data, "tui.select.down")) {
      this.#setDetailScrollOffset(
        Math.min(this.#detailMaximumScrollOffset, this.#detailEffectiveScrollOffset + 1),
      );
      return;
    }
    if (this.#focus === "details" && getKeybindings().matches(data, "tui.select.pageUp")) {
      this.#setDetailScrollOffset(
        Math.max(0, this.#detailEffectiveScrollOffset - this.#detailPageSize),
      );
      return;
    }
    if (this.#focus === "details" && getKeybindings().matches(data, "tui.select.pageDown")) {
      this.#setDetailScrollOffset(
        Math.min(
          this.#detailMaximumScrollOffset,
          this.#detailEffectiveScrollOffset + this.#detailPageSize,
        ),
      );
      return;
    }
    if (this.#focus === "details" && data === "c") {
      const action = this.#connectionAction();
      if (action !== null) {
        this.#onCheckConnection(action.target);
      }
      return;
    }
    if (
      this.#focus === "models" &&
      this.#mode === "transition" &&
      (adamCommandRegistry.matchesInput(data, "new_session_from_target") ||
        adamCommandRegistry.matchesInput(data, "fork_from_target"))
    ) {
      const selectedTargetId = this.#list.getSelectedTargetId();
      const target = selectedTargetId === null ? undefined : this.#targets.get(selectedTargetId);
      if (target !== undefined) {
        if (adamCommandRegistry.matchesInput(data, "new_session_from_target")) {
          this.#onCreate?.(target);
        } else {
          this.#onFork?.(target);
        }
      }
      return;
    }
    if (this.#focus === "models" && adamCommandRegistry.matchesInput(data, "save_default_target")) {
      const selectedTargetId = this.#list.getSelectedTargetId();
      const target = selectedTargetId === null ? undefined : this.#targets.get(selectedTargetId);
      if (target !== undefined) {
        this.#notice = null;
        this.#list.invalidate();
        // Persisting a default is deliberately distinct from the picker's Enter action.
        this.#onSetDefault(target.targetId === this.#defaultTargetId ? null : target);
      }
      return;
    }
    if (this.#focus === "details") {
      return;
    }
    const previousTargetId = this.#list.getSelectedTargetId();
    this.#list.handleInput(data);
    if (this.#list.getSelectedTargetId() !== previousTargetId) {
      this.#setDetailScrollOffset(0);
    }
  }

  invalidate(): void {
    this.#list.invalidate();
  }

  render(width: number): string[] {
    const selectedTargetId = this.#list.getSelectedTargetId();
    const target = selectedTargetId === null ? undefined : this.#targets.get(selectedTargetId);
    const physicalColumns = this.#columns();
    const maximumContentLines = Math.max(1, this.#maximumContentRows());
    const rendered = this.#renderFull(width, physicalColumns, target);
    return rendered.length <= maximumContentLines
      ? rendered
      : this.#renderFocused(width, physicalColumns, target, maximumContentLines);
  }

  #renderFull(width: number, physicalColumns: number, target: TargetDisplay | undefined): string[] {
    if (physicalColumns >= 120) {
      const gap = 3;
      const listWidth = Math.max(24, Math.min(52, Math.floor((width - gap) * 0.44)));
      const detailWidth = Math.max(1, width - listWidth - gap);
      const renderedList = this.#list.render(listWidth, physicalColumns);
      const search = renderedList.slice(0, 2);
      const models = renderedList.slice(2);
      return [
        this.#theme.toolTitle("Select an exact model target"),
        "",
        ...search,
        ...sideBySide(
          [this.#sectionTitle("Models", "models"), ...models],
          this.#visibleDetailLines(target, detailWidth),
          listWidth,
          detailWidth,
          this.#theme.muted(" │ "),
        ),
        ...(this.#notice === null ? [] : ["", ...this.#wrapped(this.#notice, width)]),
        "",
        ...this.#wrapped(this.#footer(target), width),
      ];
    }
    const renderedList = this.#list.render(width, physicalColumns);
    const search = renderedList.slice(0, 2);
    const models = renderedList.slice(2);
    return [
      this.#theme.toolTitle("Select an exact model target"),
      "",
      ...search,
      this.#sectionTitle("Models", "models"),
      ...models,
      "",
      ...this.#visibleDetailLines(target, width),
      ...(this.#notice === null ? [] : ["", ...this.#wrapped(this.#notice, width)]),
      "",
      ...this.#wrapped(this.#footer(target), width),
    ];
  }

  #renderFocused(
    width: number,
    physicalColumns: number,
    target: TargetDisplay | undefined,
    maximumContentLines: number,
  ): string[] {
    if (this.#focus === "details") {
      const reservedFooter = this.#wrapped(this.#footer(target, true), width);
      const maximumNoticeLines = Math.max(0, maximumContentLines - reservedFooter.length - 5);
      const notice =
        this.#notice === null
          ? []
          : this.#wrapped(this.#notice, width).slice(0, maximumNoticeLines);
      const search = this.#list.render(width, physicalColumns, 2).slice(0, 1);
      const detailBudget = Math.max(
        1,
        maximumContentLines - 1 - search.length - notice.length - reservedFooter.length,
      );
      const details = this.#visibleDetailLines(target, width, Math.max(0, detailBudget - 1));
      const footer = this.#wrapped(this.#footer(target), width);
      return [
        this.#theme.toolTitle("Select an exact model target"),
        ...search,
        ...details,
        ...notice,
        ...footer,
      ].slice(0, maximumContentLines);
    }
    const footer = this.#wrapped(this.#footer(target), width);
    const fixedLines = 1 + 1 + 1 + footer.length;
    const selectedRowLines = this.#list.selectedRowLineCount(width, physicalColumns);
    const maximumNoticeLines = Math.max(0, maximumContentLines - fixedLines - selectedRowLines);
    const notice =
      this.#notice === null ? [] : this.#wrapped(this.#notice, width).slice(0, maximumNoticeLines);
    const modelBudget = Math.max(1, maximumContentLines - fixedLines - notice.length);
    const renderedList = this.#list.render(width, physicalColumns, modelBudget + 2);
    const search = renderedList.slice(0, 1);
    const models = renderedList.slice(2);
    return [
      this.#theme.toolTitle("Select an exact model target"),
      ...search,
      this.#sectionTitle("Models", "models"),
      ...models,
      ...notice,
      ...footer,
    ];
  }

  #visibleDetailLines(
    target: TargetDisplay | undefined,
    width: number,
    maximumVisibleContentLines = 7,
  ): string[] {
    const [heading = this.#sectionTitle("Details", "details"), ...content] = this.#detailLines(
      target,
      width,
    );
    const maximumOffset = Math.max(0, content.length - maximumVisibleContentLines);
    const offset = Math.min(this.#detailScrollOffset, maximumOffset);
    this.#detailMaximumScrollOffset = maximumOffset;
    this.#detailEffectiveScrollOffset = offset;
    this.#detailPageSize = Math.max(1, maximumVisibleContentLines - 1);
    const visible = content.slice(offset, offset + maximumVisibleContentLines);
    if (content.length <= maximumVisibleContentLines) {
      return [heading, ...visible];
    }
    return [
      `${heading}${this.#theme.muted(` · ${offset + 1}-${offset + visible.length}/${content.length}`)}`,
      ...visible,
    ];
  }

  #detailLines(target: TargetDisplay | undefined, width: number): string[] {
    if (target === undefined) {
      return [
        this.#sectionTitle("Details", "details"),
        ...this.#wrapped("No matching model.", width),
      ];
    }
    return [
      this.#sectionTitle("Details", "details"),
      ...this.#wrapped(target.summary, width),
      ...this.#wrapped(`Exact target  ${target.targetId}`, width),
      ...this.#wrapped(
        `Provider  ${target.provider} · Route  ${target.route === "direct" ? "Direct" : "Vercel AI Gateway"}`,
        width,
      ),
      ...this.#wrapped(
        `Adam support  ${target.certification}${target.upstreamLifecycle === "Experimental" ? " · Upstream  Preview" : ""}`,
        width,
      ),
      ...(target.upstreamLifecycle === "Stable" ? this.#wrapped("Upstream  Stable", width) : []),
      ...this.#connectionLines(target, width),
      ...this.#wrapped(
        `Modalities  ${target.modalities.join(", ") || "None declared"} · Capabilities  ${target.capabilities.join(", ") || "None declared"}`,
        width,
      ),
      ...this.#wrapped(
        `Credential  ${target.readiness.credentialSource} · Readiness  ${target.readiness.status === "available" ? "Ready" : "Setup required"}`,
        width,
      ),
      ...this.#wrapped(this.#contextSummary(target), width),
      ...this.#wrapped(this.#thinkingSummary(target), width),
    ];
  }

  #contextSummary(target: TargetDisplay): string {
    if (target.context === undefined) {
      return "Context  Not declared";
    }
    const context = target.context.effective ?? target.context.official;
    return `Context  ${context.contextWindowTokens.toLocaleString("en-US")} tokens · max output ${context.maximumOutputTokens.toLocaleString("en-US")} · compact at ${context.compactAtTokens.toLocaleString("en-US")}`;
  }

  #thinkingSummary(target: TargetDisplay): string {
    if (target.thinking === null) {
      return "Thinking  Not available";
    }
    return `Thinking  default ${target.thinking.defaultLevelId} · ${target.thinking.levels.map((level) => level.label).join(", ")}`;
  }

  #connectionLines(target: TargetDisplay, width: number): string[] {
    if (target.connection === undefined) {
      return this.#wrapped("Connection  Not available", width);
    }
    if (target.connection.reachability === "Not tested") {
      return this.#wrapped("Connection not checked", width);
    }
    if (target.connection.reachability === "Testing") {
      return this.#wrapped("Connection  Checking API…", width);
    }
    return [
      ...this.#wrapped(
        `Connection  ${target.connection.reachability}${target.connection.checkedAt === null ? "" : ` · checked ${target.connection.checkedAt}`}`,
        width,
      ),
      ...(target.connection.diagnostic === null
        ? []
        : this.#wrapped(`Connection detail  ${target.connection.diagnostic.message}`, width)),
    ];
  }

  #sectionTitle(label: string, section: "details" | "models"): string {
    return this.#theme.toolTitle(`${label}${this.#focus === section ? " [focused]" : ""}`);
  }

  #footer(target: TargetDisplay | undefined, assumeBothScrollDirections = false): string {
    const actions: string[] = [];
    const ready = target?.readiness.status === "available";
    if (this.#focus === "models") {
      if (ready) {
        if (this.#mode === "transition") {
          actions.push(
            `${adamCommandRegistry.keybinding("new_session_from_target").keys} New session`,
          );
          if (this.#canFork) {
            actions.push(
              `${adamCommandRegistry.keybinding("fork_from_target").keys} Fork current boundary`,
            );
          }
        } else {
          actions.push("Enter Create");
          actions.push("↑/↓ Move");
        }
        actions.push(
          `${adamCommandRegistry.keybinding("save_default_target").keys} ${target?.targetId === this.#defaultTargetId ? "Clear default" : "Save default"}`,
        );
        actions.push("Type Search");
      } else if (target?.targetId === this.#defaultTargetId) {
        actions.push(`${adamCommandRegistry.keybinding("save_default_target").keys} Clear default`);
        actions.push("Enter Setup help");
        actions.push("Type Search");
      } else if (target !== undefined) {
        actions.push("Enter Setup help");
        actions.push("Type Search");
      }
      actions.push("Tab Details");
    } else {
      const connectionAction = this.#connectionAction();
      if (target !== undefined) {
        const canScrollUp = assumeBothScrollDirections || this.#detailEffectiveScrollOffset > 0;
        const canScrollDown =
          assumeBothScrollDirections ||
          this.#detailEffectiveScrollOffset < this.#detailMaximumScrollOffset;
        if (canScrollUp) actions.push("↑ Up");
        if (canScrollDown) actions.push("↓ Down");
        if (canScrollUp && canScrollDown) {
          actions.push("PgUp/PgDn Page");
        } else if (canScrollUp) {
          actions.push("PgUp Page");
        } else if (canScrollDown) {
          actions.push("PgDn Page");
        }
      }
      if (connectionAction?.type === "cancel") {
        actions.push(`c Cancel ${connectionAction.target.displayName} API check`);
      } else if (connectionAction?.type === "check") {
        actions.push("c Check API");
      }
      actions.push("Tab Models");
    }
    actions.push("Esc Close");
    return actions.join(" · ");
  }

  #connectionAction():
    | { readonly type: "cancel"; readonly target: TargetDisplay }
    | { readonly type: "check"; readonly target: TargetDisplay }
    | null {
    const testing = [...this.#targets.values()].filter(
      (target) => target.connection?.reachability === "Testing",
    );
    const selectedTargetId = this.#list.getSelectedTargetId();
    const selected = selectedTargetId === null ? undefined : this.#targets.get(selectedTargetId);
    if (testing.length === 1) return { type: "cancel", target: testing[0] as TargetDisplay };
    if (testing.length > 1) {
      return selected?.connection?.reachability === "Testing"
        ? { type: "cancel", target: selected }
        : null;
    }
    return selected?.readiness.status === "available" &&
      selected.connection !== undefined &&
      selected.connection.configured === "Configured"
      ? { type: "check", target: selected }
      : null;
  }

  #setDetailScrollOffset(offset: number): void {
    this.#detailScrollOffset = offset;
    this.#detailEffectiveScrollOffset = offset;
  }

  #wrapped(text: string, width: number): string[] {
    return wrapTextWithAnsi(this.#theme.muted(safeTerminalText(text)), Math.max(1, width));
  }

  #items(): TargetPickerRow[] {
    return [...this.#targets.values()]
      .sort((left, right) => this.#compare(left, right))
      .map((target) => {
        const badges = [
          ...(target.targetId === this.#currentTargetId ? ["CURRENT"] : []),
          ...(target.targetId === this.#defaultTargetId ? ["DEFAULT"] : []),
          ...(target.recommended ? ["RECOMMENDED"] : []),
          ...(target.upstreamLifecycle === "Experimental" ? ["PREVIEW"] : []),
          ...(target.certification === "Experimental" ? ["UNCERTIFIED"] : []),
          target.readiness.status === "available" ? "Ready" : "Setup",
        ];
        const item = {
          value: target.targetId,
          label: safeTerminalText(target.displayName),
          description: safeTerminalText(badges.join(" · ")),
        };
        return {
          ...item,
          searchText: `${item.label} ${item.description} ${item.value}`,
        };
      });
  }

  #compare(left: TargetDisplay, right: TargetDisplay): number {
    const rank = (target: TargetDisplay): number => {
      if (target.targetId === this.#currentTargetId) return 0;
      if (target.targetId === this.#defaultTargetId) return 1;
      if (target.recommended) return 2;
      if (target.readiness.status === "missing") return 5;
      if (target.certification === "Certified" && target.upstreamLifecycle !== "Experimental") {
        return 3;
      }
      return 4;
    };
    const rankDifference = rank(left) - rank(right);
    if (rankDifference !== 0) return rankDifference;
    for (const [leftValue, rightValue] of [
      [left.provider, right.provider],
      [left.displayName, right.displayName],
      [left.route, right.route],
      [left.targetId, right.targetId],
    ] as const) {
      if (leftValue < rightValue) return -1;
      if (leftValue > rightValue) return 1;
    }
    return 0;
  }
}

type TargetPickerRow = {
  readonly value: string;
  readonly label: string;
  readonly description: string;
  readonly searchText: string;
};

class TargetSearchList {
  #items: readonly TargetPickerRow[];
  readonly #maxVisible: number;
  readonly #onCancel: () => void;
  readonly #onSelect: (targetId: string) => void;
  readonly #theme: AdamTuiTheme;
  #query = "";
  #selectedIndex = 0;

  constructor(options: {
    readonly items: readonly TargetPickerRow[];
    readonly maxVisible: number;
    readonly onCancel: () => void;
    readonly onSelect: (targetId: string) => void;
    readonly theme: AdamTuiTheme;
  }) {
    this.#items = options.items;
    this.#maxVisible = options.maxVisible;
    this.#onCancel = options.onCancel;
    this.#onSelect = options.onSelect;
    this.#theme = options.theme;
  }

  getSelectedTargetId(): string | null {
    return this.#filtered()[this.#selectedIndex]?.value ?? null;
  }

  handleInput(data: string): void {
    const keybindings = getKeybindings();
    if (keybindings.matches(data, "tui.editor.deleteCharBackward") && this.#query.length > 0) {
      const selectedTargetId = this.getSelectedTargetId();
      this.#query = Array.from(this.#query).slice(0, -1).join("");
      this.#restoreSelection(selectedTargetId);
      return;
    }
    if (isSearchText(data)) {
      this.#query += safeTerminalText(data);
      this.#restoreSelection(null);
      return;
    }
    const filtered = this.#filtered();
    if (keybindings.matches(data, "tui.select.up")) {
      this.#selectedIndex =
        filtered.length === 0
          ? 0
          : this.#selectedIndex === 0
            ? filtered.length - 1
            : this.#selectedIndex - 1;
      return;
    }
    if (keybindings.matches(data, "tui.select.down")) {
      this.#selectedIndex = filtered.length === 0 ? 0 : (this.#selectedIndex + 1) % filtered.length;
      return;
    }
    if (keybindings.matches(data, "tui.select.confirm")) {
      const selected = filtered[this.#selectedIndex];
      if (selected !== undefined) {
        this.#onSelect(selected.value);
      }
      return;
    }
    if (keybindings.matches(data, "tui.select.cancel")) {
      this.#onCancel();
    }
  }

  invalidate(): void {}

  render(
    width: number,
    physicalColumns: number,
    maximumLines = Number.POSITIVE_INFINITY,
  ): string[] {
    const filtered = this.#filtered();
    const searchLine = truncateToWidth(
      `Search: ${safeTerminalText(this.#query)}`,
      Math.max(1, width),
      "…",
    );
    if (filtered.length === 0) {
      return [searchLine, "", this.#theme.muted("  No matching models")].slice(0, maximumLines);
    }
    const startIndex = Math.max(
      0,
      Math.min(
        this.#selectedIndex - Math.floor(this.#maxVisible / 2),
        filtered.length - this.#maxVisible,
      ),
    );
    const endIndex = Math.min(startIndex + this.#maxVisible, filtered.length);
    const renderedRows = filtered.map((row, index) =>
      this.#renderRow(row, index === this.#selectedIndex, width, physicalColumns),
    );
    const maximumRowLines = Math.max(0, maximumLines - 2);
    const bounded = Number.isFinite(maximumLines) && renderedRows.flat().length > maximumRowLines;
    const selectedRowLines = renderedRows[this.#selectedIndex]?.length ?? 0;
    const showIndicator = bounded && selectedRowLines < maximumRowLines;
    const rowBudget = Math.max(0, maximumRowLines - (showIndicator ? 1 : 0));
    const visibleIndexes = bounded
      ? this.#visibleRowIndexes(renderedRows, rowBudget)
      : Array.from({ length: endIndex - startIndex }, (_, index) => startIndex + index);
    const lines = visibleIndexes.flatMap((index) => renderedRows[index] ?? []).slice(0, rowBudget);
    if (bounded || startIndex > 0 || endIndex < filtered.length) {
      const indicator = this.#theme.muted(`  (${this.#selectedIndex + 1}/${filtered.length})`);
      if (showIndicator) {
        lines.push(indicator);
      } else if (lines.length < maximumRowLines) {
        lines.push(indicator);
      }
    }
    return [searchLine, "", ...lines].slice(0, maximumLines);
  }

  selectedRowLineCount(width: number, physicalColumns: number): number {
    const filtered = this.#filtered();
    const selected = filtered[this.#selectedIndex];
    return selected === undefined
      ? 1
      : this.#renderRow(selected, true, width, physicalColumns).length;
  }

  setItems(items: readonly TargetPickerRow[]): void {
    const selectedTargetId = this.getSelectedTargetId();
    this.#items = items;
    this.#restoreSelection(selectedTargetId);
  }

  #filtered(): TargetPickerRow[] {
    return fuzzyFilter([...this.#items], this.#query, (item) => item.searchText);
  }

  #renderRow(
    row: TargetPickerRow,
    selected: boolean,
    width: number,
    physicalColumns: number,
  ): string[] {
    const available = Math.max(1, width - 2);
    const combined = `${row.label}${row.description.length === 0 ? "" : `  ${row.description}`}`;
    if (physicalColumns >= 80 && visibleWidth(combined) <= available) {
      const spacing = " ".repeat(
        Math.max(2, available - visibleWidth(row.label) - visibleWidth(row.description)),
      );
      return [
        this.#styled(`${selected ? "> " : "  "}${row.label}${spacing}${row.description}`, selected),
      ];
    }
    const labelLines = wrapTextWithAnsi(row.label, available);
    const descriptionLines = wrapTextWithAnsi(row.description, available);
    return [
      ...labelLines.map((line, index) =>
        this.#styled(`${selected && index === 0 ? "> " : "  "}${line}`, selected),
      ),
      ...(row.description.length === 0
        ? []
        : descriptionLines.map((line) => this.#styled(`  ${line}`, selected))),
    ];
  }

  #restoreSelection(selectedTargetId: string | null): void {
    const filtered = this.#filtered();
    const selectedIndex = filtered.findIndex((row) => row.value === selectedTargetId);
    this.#selectedIndex = selectedIndex >= 0 ? selectedIndex : 0;
  }

  #visibleRowIndexes(renderedRows: readonly (readonly string[])[], maximumLines: number): number[] {
    const selected = Math.min(this.#selectedIndex, Math.max(0, renderedRows.length - 1));
    const indexes = [selected];
    let used = Math.min(renderedRows[selected]?.length ?? 0, maximumLines);
    for (let distance = 1; used < maximumLines; distance += 1) {
      const candidates = [selected + distance, selected - distance].filter(
        (index) => index >= 0 && index < renderedRows.length,
      );
      if (candidates.length === 0) break;
      for (const index of candidates) {
        const rowLines = renderedRows[index]?.length ?? 0;
        if (used + rowLines <= maximumLines) {
          indexes.push(index);
          used += rowLines;
        }
      }
    }
    return indexes.sort((left, right) => left - right);
  }

  #styled(text: string, selected: boolean): string {
    return selected ? this.#theme.editor.selectList.selectedText(text) : text;
  }
}

function sideBySide(
  left: readonly string[],
  right: readonly string[],
  leftWidth: number,
  rightWidth: number,
  divider: string,
): string[] {
  const lines: string[] = [];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftLine = truncateToWidth(left[index] ?? "", leftWidth, "");
    const rightLine = truncateToWidth(right[index] ?? "", rightWidth, "");
    lines.push(
      `${leftLine}${" ".repeat(Math.max(0, leftWidth - visibleWidth(leftLine)))}${divider}${rightLine}`,
    );
  }
  return lines;
}

function isSearchText(data: string): boolean {
  return data.length > 0 && !/[\p{Cc}\p{Cf}]/u.test(data);
}
