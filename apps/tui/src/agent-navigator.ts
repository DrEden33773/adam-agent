import type { AuthoritativePresentationSnapshot } from "@adam-agent/presentation";
import { type Component, getKeybindings, truncateToWidth } from "@earendil-works/pi-tui";

import { safeTerminalText } from "./safe-terminal-text.js";
import { type SearchableSelectItem, SearchableSelectList } from "./searchable-select-list.js";
import type { AdamTuiTheme } from "./theme.js";

type ManagedAgents = AuthoritativePresentationSnapshot["managedAgents"];
type ManagedAgent = ManagedAgents["agents"][number];

export class AgentNavigator implements Component {
  readonly #managedAgents: ManagedAgents;
  readonly #onCancel: (input: {
    readonly agentId: string;
    readonly expectedRevision: number;
  }) => void;
  readonly #onChange: () => void;
  readonly #onClose: () => void;
  readonly #onReply: (input: {
    readonly agentId: string;
    readonly expectedRevision: number;
    readonly attentionId: string;
  }) => void;
  readonly #theme: AdamTuiTheme;
  #detail: ManagedAgent | null = null;
  readonly #list: SearchableSelectList;

  constructor(options: {
    readonly managedAgents: ManagedAgents;
    readonly onCancel: (input: {
      readonly agentId: string;
      readonly expectedRevision: number;
    }) => void;
    readonly onChange: () => void;
    readonly onClose: () => void;
    readonly onReply: (input: {
      readonly agentId: string;
      readonly expectedRevision: number;
      readonly attentionId: string;
    }) => void;
    readonly theme: AdamTuiTheme;
  }) {
    this.#managedAgents = options.managedAgents;
    this.#onCancel = options.onCancel;
    this.#onChange = options.onChange;
    this.#onClose = options.onClose;
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
        this.#onChange();
      },
      theme: options.theme.editor.selectList,
    });
  }

  handleInput(data: string): void {
    if (this.#detail !== null && getKeybindings().matches(data, "tui.select.cancel")) {
      this.#detail = null;
      this.#onChange();
      return;
    }
    if (this.#detail !== null) {
      if (
        data === "c" &&
        (this.#detail.status === "running" || this.#detail.status === "waiting_for_parent")
      ) {
        this.#onCancel({
          agentId: this.#detail.agentId,
          expectedRevision: this.#detail.revision,
        });
      }
      if (
        data === "r" &&
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

  render(width: number): string[] {
    if (this.#detail !== null) {
      return [
        this.#theme.toolTitle("Agent detail"),
        `${this.#detail.profile} · ${this.#detail.mode} · ${this.#detail.status} · revision ${this.#detail.revision}`,
        `Agent ${safeTerminalText(this.#detail.agentId)}`,
        `Attempt ${safeTerminalText(this.#detail.attemptId)}`,
        ...(this.#detail.result === undefined
          ? []
          : "text" in this.#detail.result
            ? ["", ...safeTerminalText(this.#detail.result.text).split("\n")]
            : [
                "",
                `Result artifact ${safeTerminalText(this.#detail.result.artifact.id)} · ${this.#detail.result.artifact.byteCount} bytes`,
              ]),
        ...(this.#detail.error === undefined
          ? []
          : [
              "",
              `${safeTerminalText(this.#detail.error.code)} · ${safeTerminalText(this.#detail.error.message)}`,
            ]),
        ...(this.#detail.attention === undefined
          ? []
          : [
              "",
              `${this.#detail.attention.status === "waiting" ? "Parent input requested" : "Parent input orphaned"} · ${safeTerminalText(this.#detail.attention.question)}`,
            ]),
        ...(this.#detail.reports ?? []).flatMap((report) => [
          "",
          `${report.kind} r${report.revision} · ${safeTerminalText(report.message)}${report.messageTruncated ? ` · ${report.messageByteCount} bytes total` : ""}`,
        ]),
        "",
        this.#theme.muted(
          this.#detail.status === "running"
            ? "c cancel exact revision · Esc back · Ctrl+Q exit"
            : this.#detail.status === "waiting_for_parent"
              ? "r reply exact attention · c cancel exact revision · Esc back · Ctrl+Q exit"
              : "Terminal child · Esc back · Ctrl+Q exit",
        ),
      ].map((line) => boundedLine(line, width));
    }
    return [
      this.#theme.toolTitle(
        `Agents · ${this.#managedAgents.counts.active} active · ${this.#managedAgents.counts.terminal} terminal`,
      ),
      "",
      ...this.#list.render(width),
      "",
      this.#theme.muted("type search · Enter detail · Esc close · Ctrl+Q exit"),
    ].map((line) => boundedLine(line, width));
  }
}

function boundedLine(line: string, width: number): string {
  const bounded = truncateToWidth(line, Math.max(1, width), "");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip formatter-added ANSI resets only from an originally plain NO_COLOR line.
  return line.includes("\u001b[") ? bounded : bounded.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");
}
