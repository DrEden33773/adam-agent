import type { ActiveSessionDisplay } from "@adam-agent/presentation";
import { type Component, getKeybindings, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { safeTerminalText } from "./safe-terminal-text.js";
import type { SessionRunStatus } from "./session-inspector.js";
import type { AdamTuiTheme } from "./theme.js";

export class SessionSettings implements Component {
  #active: ActiveSessionDisplay;
  #runStatus: SessionRunStatus;
  #pending = false;
  #notice: string | null = null;
  readonly #theme: AdamTuiTheme;
  readonly #onClose: () => void;
  readonly #onChange: () => void;
  readonly #onUpgrade: (sessionId: string) => Promise<string>;

  constructor(options: {
    readonly active: ActiveSessionDisplay;
    readonly runStatus: SessionRunStatus;
    readonly theme: AdamTuiTheme;
    readonly onClose: () => void;
    readonly onChange: () => void;
    readonly onUpgrade: (sessionId: string) => Promise<string>;
  }) {
    this.#active = options.active;
    this.#runStatus = options.runStatus;
    this.#theme = options.theme;
    this.#onClose = options.onClose;
    this.#onChange = options.onChange;
    this.#onUpgrade = options.onUpgrade;
  }

  setState(options: {
    readonly active: ActiveSessionDisplay;
    readonly runStatus: SessionRunStatus;
    readonly throughSequence?: number | null;
  }): void {
    this.#active = options.active;
    this.#runStatus = options.runStatus;
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    if (keys.matches(data, "tui.select.cancel")) {
      this.#onClose();
      return;
    }
    if (!keys.matches(data, "tui.select.confirm") || !this.#canUpgrade()) return;
    this.#pending = true;
    this.#notice = null;
    this.#onChange();
    void this.#onUpgrade(this.#active.session.id)
      .then((message) => {
        this.#notice = message;
      })
      .catch(() => {
        this.#notice = "Todo permission could not be updated.";
      })
      .finally(() => {
        this.#pending = false;
        this.#onChange();
      });
  }

  invalidate(): void {}

  render(width: number): string[] {
    const policy = this.#active.todoPermissionPolicy ?? "todo-permission.legacy-v1";
    const current = policy === "todo-permission.session-v1";
    const action = this.#pending
      ? "Updating Todo permission…"
      : current
        ? "Session Todo defaults enabled."
        : this.#active.todo === undefined
          ? "Todo is unavailable in this session."
          : this.#canUpgrade()
            ? "Enter enable session Todo defaults"
            : "Finish current work before upgrading.";
    return [
      this.#theme.toolTitle("Session settings"),
      `Policy: ${policy}`,
      this.#theme.subject(action),
      ...(this.#notice === null ? [] : [safeTerminalText(this.#notice)]),
      this.#theme.muted("Esc close · Ctrl+Q exit"),
      "",
      "Create, update and batch Todo calls use session defaults; explicit denials still apply.",
      "Upgrading affects future calls and new Plan cycles. Existing Plan policies and pending requests stay unchanged.",
    ].flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
  }

  #canUpgrade(): boolean {
    return (
      !this.#pending &&
      this.#runStatus === "idle" &&
      this.#active.todo !== undefined &&
      this.#active.todoPermissionPolicy !== "todo-permission.session-v1"
    );
  }
}
