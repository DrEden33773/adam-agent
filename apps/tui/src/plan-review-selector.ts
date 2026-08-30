import {
  type Component,
  getKeybindings,
  type SelectItem,
  SelectList,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { safeTerminalText } from "./safe-terminal-text.js";
import type { AdamTuiTheme } from "./theme.js";

export type PlanReviewAction = "approve" | "cancel" | "revise";

const actions: readonly (SelectItem & { readonly value: PlanReviewAction })[] = [
  {
    value: "approve",
    label: "Approve and implement",
    description: "Approve this exact artifact and start its one implementation run.",
  },
  {
    value: "revise",
    label: "Request changes…",
    description: "Return to the main composer with revision intent; ready state is retained.",
  },
  {
    value: "cancel",
    label: "Cancel plan",
    description: "Request confirmation before cancelling this Plan cycle.",
  },
];

export class PlanReviewSelector implements Component {
  readonly #contentDigest: `sha256:${string}`;
  readonly #list: SelectList;
  readonly #markdown: string;
  readonly #theme: AdamTuiTheme;
  readonly #title: string | undefined;
  #page = 0;

  constructor(options: {
    readonly contentDigest: `sha256:${string}`;
    readonly markdown: string;
    readonly onClose: () => void;
    readonly onSelect: (action: PlanReviewAction) => void;
    readonly theme: AdamTuiTheme;
    readonly title?: string;
  }) {
    this.#contentDigest = options.contentDigest;
    this.#markdown = options.markdown;
    this.#theme = options.theme;
    this.#title = options.title;
    this.#list = new SelectList([...actions], actions.length, options.theme.editor.selectList);
    this.#list.onSelect = (item) => options.onSelect(item.value as PlanReviewAction);
    this.#list.onCancel = options.onClose;
  }

  handleInput(data: string): void {
    if (getKeybindings().matches(data, "tui.select.pageDown")) {
      this.#page += 1;
      return;
    }
    if (getKeybindings().matches(data, "tui.select.pageUp")) {
      this.#page = Math.max(0, this.#page - 1);
      return;
    }
    this.#list.handleInput(data);
  }

  invalidate(): void {
    this.#list.invalidate();
  }

  render(width: number): string[] {
    const planLines = wrapTextWithAnsi(safeTerminalText(this.#markdown), Math.max(1, width));
    const pageSize = 8;
    const pageCount = Math.max(1, Math.ceil(planLines.length / pageSize));
    this.#page = Math.min(this.#page, pageCount - 1);
    const pageStart = this.#page * pageSize;
    return [
      this.#theme.toolTitle("Review exact submitted plan"),
      ...(this.#title === undefined
        ? []
        : [truncateToWidth(this.#theme.keyword(safeTerminalText(this.#title)), width)]),
      truncateToWidth(this.#theme.muted(safeTerminalText(this.#contentDigest)), width),
      "",
      ...planLines.slice(pageStart, pageStart + pageSize),
      this.#theme.muted(`Plan page ${this.#page + 1}/${pageCount} · PageUp/PageDown inspect`),
      "",
      ...this.#list.render(width),
      "",
      this.#theme.muted("Enter choose · Esc keep ready · Ctrl+Q exit"),
    ];
  }
}

export class PlanContinuationSelector implements Component {
  readonly #list: SelectList;
  readonly #theme: AdamTuiTheme;

  constructor(options: {
    readonly onClose: () => void;
    readonly onContinue: () => void;
    readonly theme: AdamTuiTheme;
  }) {
    this.#theme = options.theme;
    this.#list = new SelectList(
      [
        {
          value: "continue",
          label: "Continue implementation",
          description: "Reuse the durable approval intent and its reserved implementation run.",
        },
      ],
      1,
      options.theme.editor.selectList,
    );
    this.#list.onSelect = () => options.onContinue();
    this.#list.onCancel = options.onClose;
  }

  handleInput(data: string): void {
    this.#list.handleInput(data);
  }

  invalidate(): void {
    this.#list.invalidate();
  }

  render(width: number): string[] {
    return [
      this.#theme.toolTitle("Approved plan has not started"),
      "",
      ...this.#list.render(width),
      "",
      this.#theme.muted("Enter continue exact approval · Esc close · Ctrl+Q exit"),
    ];
  }
}

export class PlanCancellationConfirmation implements Component {
  readonly #list: SelectList;
  readonly #theme: AdamTuiTheme;

  constructor(options: {
    readonly onBack: () => void;
    readonly onConfirm: () => void;
    readonly theme: AdamTuiTheme;
  }) {
    this.#theme = options.theme;
    this.#list = new SelectList(
      [
        {
          value: "back",
          label: "Return to review",
          description: "Keep this exact submitted plan ready.",
        },
        {
          value: "confirm",
          label: "Confirm cancellation",
          description: "Durably cancel this exact Plan cycle.",
        },
      ],
      2,
      options.theme.editor.selectList,
    );
    this.#list.onSelect = (item) => {
      if (item.value === "confirm") {
        options.onConfirm();
      } else {
        options.onBack();
      }
    };
    this.#list.onCancel = options.onBack;
  }

  handleInput(data: string): void {
    this.#list.handleInput(data);
  }

  invalidate(): void {
    this.#list.invalidate();
  }

  render(width: number): string[] {
    return [
      this.#theme.toolTitle("Cancel this exact plan?"),
      "",
      ...this.#list.render(width),
      "",
      this.#theme.muted("Enter choose · Esc return to review · Ctrl+Q exit"),
    ];
  }
}
