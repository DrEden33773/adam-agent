import type { SkillCatalogDisplay } from "@adam-agent/presentation";
import { type Component, type SelectItem, SelectList } from "@earendil-works/pi-tui";

import { safeTerminalText } from "./safe-terminal-text.js";
import type { AdamTuiTheme } from "./theme.js";

type SkillDisplay = SkillCatalogDisplay["items"][number];

export class SkillPalette implements Component {
  readonly #catalog: SkillCatalogDisplay;
  readonly #list: SelectList;
  readonly #onClose: () => void;
  readonly #onToggle: (skill: SkillDisplay) => boolean;
  readonly #skills: ReadonlyMap<string, SkillDisplay>;
  readonly #theme: AdamTuiTheme;
  #notice: string | null = null;

  constructor(options: {
    readonly catalog: SkillCatalogDisplay;
    readonly onClose: () => void;
    readonly onToggle: (skill: SkillDisplay) => boolean;
    readonly theme: AdamTuiTheme;
  }) {
    this.#catalog = options.catalog;
    this.#onClose = options.onClose;
    this.#onToggle = options.onToggle;
    this.#skills = new Map(options.catalog.items.map((skill) => [skill.qualifiedId, skill]));
    this.#theme = options.theme;
    const items: SelectItem[] = options.catalog.items.map((skill) => ({
      value: skill.qualifiedId,
      label: safeTerminalText(skill.qualifiedId),
      description: safeTerminalText(
        `${skill.name} · ${sourceLabel(skill.source)} · ${skill.active ? "active" : "available"} · ${skill.description}`,
      ),
    }));
    this.#list = new SelectList(items, 8, options.theme.editor.selectList, {
      maxPrimaryColumnWidth: 42,
    });
    this.#list.onCancel = this.#onClose;
    this.#list.onSelect = (item) => {
      const skill = this.#skills.get(item.value);
      if (skill !== undefined) {
        const selected = this.#onToggle(skill);
        this.#notice = `${selected ? "Selected" : "Cleared"} ${safeTerminalText(skill.qualifiedId)} for the next turn.`;
        this.#onClose();
      }
    };
  }

  handleInput(data: string): void {
    this.#list.handleInput(data);
  }

  invalidate(): void {
    this.#list.invalidate();
  }

  render(width: number): string[] {
    const selectedItem = this.#list.getSelectedItem();
    const selected = selectedItem === null ? undefined : this.#skills.get(selectedItem.value);
    return [
      this.#theme.toolTitle("Select next-turn Skills"),
      "",
      ...this.#list.render(width),
      ...(selected === undefined
        ? []
        : [
            "",
            safeTerminalText(selected.description),
            this.#theme.muted(
              safeTerminalText(
                `${sourceLabel(selected.source)} · ${selected.active ? "active" : "available"}`,
              ),
            ),
          ]),
      this.#theme.muted(
        `Catalog r${this.#catalog.revision} · ${this.#catalog.overflow.omittedCount} omitted · ${this.#catalog.overflow.shortenedCount} shortened · ${this.#catalog.diagnostics.length} diagnostics`,
      ),
      ...this.#catalog.diagnostics.map((diagnostic) =>
        this.#theme.muted(
          safeTerminalText(
            `${diagnostic.code} · ${diagnostic.source}${
              diagnostic.scope === undefined ? "" : `:${diagnostic.scope}`
            } · ${diagnostic.packagePath}`,
          ),
        ),
      ),
      ...(this.#notice === null ? [] : ["", this.#theme.muted(this.#notice)]),
      "",
      this.#theme.muted("Enter toggle · Esc close · exact qualified IDs only"),
    ];
  }
}

function sourceLabel(source: SkillDisplay["source"]): string {
  if (source.type === "project") {
    return `project:${source.scope}`;
  }
  if (source.type === "user") {
    return "user";
  }
  return `extension:${source.extensionId}@${source.packageVersion}`;
}
