import type { McpDisplay } from "@adam-agent/presentation";
import {
  type Component,
  isKeyRelease,
  isKeyRepeat,
  Key,
  matchesKey,
  SelectList,
  truncateToWidth,
} from "@earendil-works/pi-tui";

import { safeTerminalText } from "./safe-terminal-text.js";
import type { AdamTuiTheme } from "./theme.js";

type McpEffect = NonNullable<McpDisplay["profile"]>["tools"][number]["effect"];
type McpSelection = {
  readonly qualifiedName: string;
  readonly definitionDigest: `sha256:${string}`;
  readonly effect: McpEffect;
};

const effectKeys = {
  "1": "read",
  "2": "write",
  "3": "execute",
  "4": "network",
  "5": "delegate",
  "6": "administrative",
} as const satisfies Readonly<Record<"1" | "2" | "3" | "4" | "5" | "6", McpEffect>>;

export class McpWizard implements Component {
  readonly #maximumContentHeight: () => number;
  readonly #onAdvance: (state: McpDisplay) => void;
  readonly #onClose: () => void;
  readonly #onCommit: (state: McpDisplay, selections: readonly McpSelection[]) => void;
  readonly #selections = new Map<string, McpSelection>();
  readonly #theme: AdamTuiTheme;
  #notice: string | null = null;
  #state: McpDisplay;
  #tools: SelectList;

  constructor(options: {
    readonly maximumContentHeight?: () => number;
    readonly state: McpDisplay;
    readonly onAdvance: (state: McpDisplay) => void;
    readonly onClose: () => void;
    readonly onCommit: (state: McpDisplay, selections: readonly McpSelection[]) => void;
    readonly theme: AdamTuiTheme;
  }) {
    this.#maximumContentHeight = options.maximumContentHeight ?? (() => 22);
    this.#state = options.state;
    this.#onAdvance = options.onAdvance;
    this.#onClose = options.onClose;
    this.#onCommit = options.onCommit;
    this.#theme = options.theme;
    this.#tools = this.#createToolList();
  }

  setState(state: McpDisplay): void {
    if (state.catalog?.digest !== this.#state.catalog?.digest) {
      this.#selections.clear();
    }
    this.#state = state;
    this.#notice = null;
    this.#tools = this.#createToolList();
  }

  setNotice(notice: string): void {
    this.#notice = safeTerminalText(notice);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.#onClose();
      return;
    }
    if (this.#state.status !== "tool_selection_required") {
      if (matchesKey(data, Key.enter)) {
        this.#onAdvance(this.#state);
      }
      return;
    }
    const effectKey = (Object.keys(effectKeys) as (keyof typeof effectKeys)[]).find((key) =>
      matchesKey(data, key),
    );
    const effect = effectKey === undefined ? undefined : effectKeys[effectKey];
    if (effect !== undefined) {
      if (isKeyRepeat(data) || isKeyRelease(data)) {
        return;
      }
      const selected = this.#tools.getSelectedItem();
      const tool = this.#state.catalog?.tools.find(
        (candidate) => candidate.qualifiedName === selected?.value,
      );
      if (tool !== undefined) {
        this.#selections.set(tool.qualifiedName, {
          qualifiedName: tool.qualifiedName,
          definitionDigest: tool.definitionDigest,
          effect,
        });
        this.#notice = `${safeTerminalText(tool.qualifiedName)} · ${effect}`;
      }
      return;
    }
    if (matchesKey(data, "c")) {
      if (isKeyRepeat(data) || isKeyRelease(data)) {
        return;
      }
      if (this.#selections.size === 0) {
        this.#notice = "Select and classify at least one exact tool before commit.";
      } else {
        this.#onCommit(this.#state, [...this.#selections.values()]);
      }
      return;
    }
    this.#tools.handleInput(data);
  }

  invalidate(): void {
    this.#tools.invalidate();
  }

  render(width: number): string[] {
    const maximumContentHeight = Math.max(4, Math.floor(this.#maximumContentHeight()));
    if (this.#state.status === "tool_selection_required") {
      const selected = this.#tools.getSelectedItem();
      const tool = this.#state.catalog?.tools.find(
        (candidate) => candidate.qualifiedName === selected?.value,
      );
      const selection = tool === undefined ? undefined : this.#selections.get(tool.qualifiedName);
      const coreLines = [
        this.#theme.toolTitle("MCP authority · tool selection required"),
        this.#theme.muted(
          `${safeTerminalText(this.#state.source.path)} · ${this.#state.source.digest}`,
        ),
        tool === undefined ? "Tool unavailable" : `Tool > ${safeTerminalText(tool.qualifiedName)}`,
        tool === undefined
          ? this.#theme.muted("No exact catalog tool is selected.")
          : this.#theme.muted(
              `${safeTerminalText(tool.originalName)} · ${selection?.effect ?? "unclassified"} · ${safeTerminalText(tool.description)}`,
            ),
        ...(this.#notice === null ? [] : [this.#theme.muted(this.#notice)]),
        this.#theme.muted("↑↓ tool · 1 read · 2 write"),
        this.#theme.muted("3 execute · 4 network · 5 delegate"),
        this.#theme.muted("6 administrative · c commit · Esc"),
      ];
      const evidenceLines = this.#state.servers.flatMap((server) => [
        `${safeTerminalText(server.serverId)} · ${server.status} · ${commandLabel(server.command)}`,
        this.#theme.muted(
          `effects ${server.startupEffects.join("+")} · ${server.definitionDigest}`,
        ),
      ]);
      return [...coreLines, ...evidenceLines]
        .slice(0, maximumContentHeight)
        .map((line) => truncateToWidth(line, width));
    }
    const lines = [
      this.#theme.toolTitle(`MCP authority · ${statusLabel(this.#state.status)}`),
      this.#theme.muted(`${this.#state.source.path} · ${this.#state.source.digest}`),
      "",
      ...this.#state.servers.flatMap((server) => [
        `${safeTerminalText(server.serverId)} · ${server.status} · ${commandLabel(server.command)}`,
        this.#theme.muted(
          `args ${server.arguments.map(safeTerminalText).join(" ") || "none"} · cwd ${safeTerminalText(server.cwd)} · env ${server.requestedEnvironmentNames.map(safeTerminalText).join(",") || "none"}`,
        ),
        this.#theme.muted(
          `effects ${server.startupEffects.join("+")} · ${server.definitionDigest}`,
        ),
      ]),
    ];
    if (this.#state.catalog !== null) {
      lines.push(
        "",
        `Catalog ${this.#state.catalog.status} · ${this.#state.catalog.digest}`,
        ...this.#tools.render(width),
      );
    }
    if (this.#state.profile !== null) {
      lines.push(
        "",
        `Profile ${this.#state.profile.digest}`,
        ...this.#state.profile.tools.map(
          (tool) => `${safeTerminalText(tool.qualifiedName)} · ${tool.effect}`,
        ),
      );
    }
    if (this.#state.diagnostics.length > 0) {
      lines.push(
        "",
        ...this.#state.diagnostics.map(
          (diagnostic) =>
            `${safeTerminalText(diagnostic.code)}${diagnostic.serverId === undefined ? "" : ` · ${safeTerminalText(diagnostic.serverId)}`}`,
        ),
      );
    }
    if (this.#notice !== null) {
      lines.push("", this.#theme.muted(this.#notice));
    }
    lines.push("", this.#theme.muted(actionLabel(this.#state.status)));
    if (lines.length <= maximumContentHeight) {
      return lines;
    }
    return [
      ...lines.slice(0, Math.max(1, maximumContentHeight - 2)),
      this.#theme.muted("Additional MCP evidence hidden; enlarge the terminal."),
      this.#theme.muted(actionLabel(this.#state.status)),
    ].slice(0, maximumContentHeight);
  }

  #createToolList(): SelectList {
    return new SelectList(
      (this.#state.catalog?.tools ?? []).map((tool) => ({
        value: tool.qualifiedName,
        label: safeTerminalText(tool.qualifiedName),
        description: safeTerminalText(
          `${tool.originalName} · ${this.#selections.get(tool.qualifiedName)?.effect ?? "unclassified"} · ${tool.description}`,
        ),
      })),
      8,
      this.#theme.editor.selectList,
      { maxPrimaryColumnWidth: 42 },
    );
  }
}

function statusLabel(status: McpDisplay["status"]): string {
  return status.replaceAll("_", " ");
}

function commandLabel(command: McpDisplay["servers"][number]["command"]): string {
  return command.kind === "executable"
    ? `executable ${safeTerminalText(command.path)}`
    : `npm ${safeTerminalText(command.packageName)}@${safeTerminalText(command.version)}`;
}

function actionLabel(status: McpDisplay["status"]): string {
  if (status === "tool_selection_required") {
    return "1 read · 2 write · 3 execute · 4 network · 5 delegate · 6 administrative · c commit";
  }
  if (status === "profile_committed" || status === "mcp_shutdown_unconfirmed") {
    return "Esc close";
  }
  return "Enter perform this exact step · Esc close";
}
