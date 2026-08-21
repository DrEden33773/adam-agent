/**
 * Keybinding rows adapt the effective Editor bindings exported by @earendil-works/pi-tui 0.84.2 (MIT); Adam-owned overlay and process actions remain local. See THIRD_PARTY_NOTICES.md.
 */
import { getKeybindings, type Keybinding, type KeyId, matchesKey } from "@earendil-works/pi-tui";

export type AdamCommandDefinition = {
  readonly aliases: readonly string[];
  readonly availability: "always" | "idle";
  readonly id: "fork" | "help" | "history" | "hotkeys" | "instructions" | "mcp" | "name" | "skills";
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
};

export type AdamKeybindingDefinition = {
  readonly action: "back" | "exit" | "interrupt" | "submit" | null;
  readonly description: string;
  readonly inputs: readonly KeyId[];
  readonly keys: string;
  readonly section: "application" | "editor";
};

export type AdamHelpTopicDefinition = {
  readonly id: "commands" | "editor" | "hotkeys";
  readonly label: string;
  readonly summary: string;
};

export type AdamCommandParseResult =
  | { readonly kind: "not_command" }
  | { readonly argumentsText: string; readonly kind: "unknown"; readonly name: string }
  | {
      readonly argumentsText: string;
      readonly command: AdamCommandDefinition;
      readonly kind: "known";
    };

class AdamCommandRegistry {
  readonly #commands: readonly AdamCommandDefinition[];
  readonly #commandsByName: ReadonlyMap<string, AdamCommandDefinition>;

  constructor(commands: readonly AdamCommandDefinition[]) {
    this.#commands = commands;
    this.#commandsByName = new Map(
      commands.flatMap((command) =>
        [command.name, ...command.aliases].map((name) => [name, command]),
      ),
    );
  }

  entries(): readonly AdamCommandDefinition[] {
    return this.#commands;
  }

  keybindings(): readonly AdamKeybindingDefinition[] {
    return effectiveKeybindings();
  }

  helpTopics(): readonly AdamHelpTopicDefinition[] {
    return fixedHelpTopics;
  }

  footerHint(): string {
    const help = this.#commandsByName.get("help");
    const hotkeys = this.#commandsByName.get("hotkeys");
    const autocomplete = this.keybindings().find((binding) => binding.inputs.includes("tab"));
    if (help === undefined || hotkeys === undefined || autocomplete === undefined) {
      throw new TypeError("The Adam interaction hint commands and keybinding must exist.");
    }
    return `${help.usage} · ${hotkeys.usage} · ${autocomplete.keys} complete`;
  }

  suggestHelpTopics(query: string, limit = 3): readonly AdamHelpTopicDefinition[] {
    return rankSuggestions(fixedHelpTopics, query, (topic) => topic.id, limit);
  }

  parse(text: string): AdamCommandParseResult {
    const normalized = text.trimEnd();
    if (!normalized.startsWith("/")) {
      return { kind: "not_command" };
    }
    const separator = normalized.search(/\s/u);
    const name = normalized.slice(1, separator < 0 ? undefined : separator);
    const argumentsText = separator < 0 ? "" : normalized.slice(separator).trimStart();
    if (!/^[a-z]+$/.test(name)) {
      return { argumentsText, kind: "unknown", name };
    }
    const command = this.#commandsByName.get(name);
    return command === undefined
      ? { argumentsText, kind: "unknown", name }
      : { argumentsText, command, kind: "known" };
  }

  isAvailable(command: AdamCommandDefinition, state: { readonly runActive: boolean }): boolean {
    return command.availability === "always" || !state.runActive;
  }

  matchesInput(data: string, action: Exclude<AdamKeybindingDefinition["action"], null>): boolean {
    return this.keybindings().some(
      (binding) =>
        binding.action === action && binding.inputs.some((input) => matchesKey(data, input)),
    );
  }

  suggest(name: string, limit = 3): readonly AdamCommandDefinition[] {
    return rankSuggestions(this.#commands, name, (command) => command.name, limit);
  }
}

export const adamCommandRegistry = new AdamCommandRegistry([
  {
    aliases: [],
    availability: "always",
    id: "help",
    name: "help",
    summary: "Browse Adam commands and interaction help.",
    usage: "/help [topic]",
  },
  {
    aliases: [],
    availability: "always",
    id: "hotkeys",
    name: "hotkeys",
    summary: "Show the fixed effective keyboard map.",
    usage: "/hotkeys",
  },
  {
    aliases: [],
    availability: "idle",
    id: "name",
    name: "name",
    summary: "Set, clear, or regenerate the active session name.",
    usage: "/name <text|--clear|--generate>",
  },
  {
    aliases: [],
    availability: "idle",
    id: "history",
    name: "history",
    summary: "Load the next older authoritative transcript page.",
    usage: "/history",
  },
  {
    aliases: ["branch"],
    availability: "idle",
    id: "fork",
    name: "fork",
    summary: "Create a child session from an authoritative boundary.",
    usage: "/fork",
  },
  {
    aliases: [],
    availability: "idle",
    id: "instructions",
    name: "instructions",
    summary: "Inspect or reload repository instruction status.",
    usage: "/instructions [reload]",
  },
  {
    aliases: [],
    availability: "idle",
    id: "skills",
    name: "skills",
    summary: "Select exact Skills or reload the Skill catalog.",
    usage: "/skills [reload]",
  },
  {
    aliases: [],
    availability: "idle",
    id: "mcp",
    name: "mcp",
    summary: "Open the project MCP authority wizard.",
    usage: "/mcp",
  },
]);

type KeybindingProjection = {
  readonly action: AdamKeybindingDefinition["action"];
  readonly description: string;
  readonly section: AdamKeybindingDefinition["section"];
} & (
  | { readonly adamInputs: readonly KeyId[]; readonly keys: string }
  | { readonly piBindings: readonly Keybinding[] }
);

const keybindingProjections: readonly KeybindingProjection[] = [
  {
    action: "submit",
    description: "Submit or confirm the focused action",
    piBindings: ["tui.input.submit"],
    section: "application",
  },
  {
    action: null,
    description: "Insert a newline",
    piBindings: ["tui.input.newLine"],
    section: "application",
  },
  {
    action: "back",
    adamInputs: ["escape"],
    keys: "Esc",
    description: "Back or close the focused page; deny a permission",
    section: "application",
  },
  {
    action: "interrupt",
    adamInputs: ["ctrl+c"],
    keys: "Ctrl+C",
    description: "Close Help; otherwise abort a run or arm idle exit",
    section: "application",
  },
  {
    action: "exit",
    adamInputs: ["ctrl+q"],
    keys: "Ctrl+Q",
    description: "Exit Adam",
    section: "application",
  },
  {
    action: null,
    description: "Open or accept autocomplete",
    piBindings: ["tui.input.tab"],
    section: "application",
  },
  {
    action: null,
    description: "Move cursor or picker; traverse prompt history at the edge",
    piBindings: ["tui.editor.cursorUp", "tui.editor.cursorDown"],
    section: "editor",
  },
  {
    action: null,
    description: "Move one character",
    piBindings: ["tui.editor.cursorLeft", "tui.editor.cursorRight"],
    section: "editor",
  },
  {
    action: null,
    description: "Move one word",
    piBindings: ["tui.editor.cursorWordLeft", "tui.editor.cursorWordRight"],
    section: "editor",
  },
  {
    action: null,
    description: "Move to line start or end",
    piBindings: ["tui.editor.cursorLineStart", "tui.editor.cursorLineEnd"],
    section: "editor",
  },
  {
    action: null,
    description: "Move by one editor or picker page",
    piBindings: ["tui.editor.pageUp", "tui.editor.pageDown"],
    section: "editor",
  },
  {
    action: null,
    description: "Delete one character",
    piBindings: ["tui.editor.deleteCharBackward", "tui.editor.deleteCharForward"],
    section: "editor",
  },
  {
    action: null,
    description: "Delete the previous word",
    piBindings: ["tui.editor.deleteWordBackward"],
    section: "editor",
  },
  {
    action: null,
    description: "Delete the next word",
    piBindings: ["tui.editor.deleteWordForward"],
    section: "editor",
  },
  {
    action: null,
    description: "Delete to line start or end",
    piBindings: ["tui.editor.deleteToLineStart", "tui.editor.deleteToLineEnd"],
    section: "editor",
  },
  {
    action: null,
    description: "Yank or rotate the kill ring",
    piBindings: ["tui.editor.yank", "tui.editor.yankPop"],
    section: "editor",
  },
  {
    action: null,
    description: "Undo the last editor change",
    piBindings: ["tui.editor.undo"],
    section: "editor",
  },
  {
    action: null,
    description: "Jump forward or backward to a character",
    piBindings: ["tui.editor.jumpForward", "tui.editor.jumpBackward"],
    section: "editor",
  },
];

const fixedHelpTopics: readonly AdamHelpTopicDefinition[] = [
  { id: "commands", label: "Commands", summary: "Command names, arguments, and aliases" },
  { id: "hotkeys", label: "Hotkeys", summary: "Fixed effective keyboard bindings" },
  { id: "editor", label: "Editor", summary: "Pi Editor navigation and editing bindings" },
];

function rankSuggestions<Entry>(
  entries: readonly Entry[],
  query: string,
  identify: (entry: Entry) => string,
  limit: number,
): readonly Entry[] {
  const maximumDistance = Math.max(2, Math.floor(query.length / 3));
  return entries
    .map((entry) => ({
      entry,
      id: identify(entry),
      distance: editDistance(query, identify(entry)),
    }))
    .filter(({ id, distance }) => id.includes(query) || distance <= maximumDistance)
    .sort((left, right) => left.distance - right.distance || left.id.localeCompare(right.id))
    .slice(0, limit)
    .map(({ entry }) => entry);
}

function editDistance(left: string, right: string): number {
  const rows = Array.from({ length: left.length + 1 }, (_, index) => index);
  for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
    let diagonal = rows[0] ?? 0;
    rows[0] = rightIndex;
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      const above = rows[leftIndex] ?? 0;
      rows[leftIndex] = Math.min(
        above + 1,
        (rows[leftIndex - 1] ?? 0) + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return rows[left.length] ?? right.length;
}

function effectiveKeybindings(): readonly AdamKeybindingDefinition[] {
  const piKeybindings = getKeybindings();
  return keybindingProjections.map((projection) => {
    if ("adamInputs" in projection) {
      return {
        action: projection.action,
        description: projection.description,
        inputs: projection.adamInputs,
        keys: projection.keys,
        section: projection.section,
      };
    }
    const inputs = projection.piBindings.flatMap((binding) => piKeybindings.getKeys(binding));
    return {
      action: projection.action,
      description: projection.description,
      inputs,
      keys: inputs.map(formatKeyId).join(" / "),
      section: projection.section,
    };
  });
}

function formatKeyId(key: KeyId): string {
  const names: Readonly<Record<string, string>> = {
    alt: "Alt",
    backspace: "Backspace",
    ctrl: "Ctrl",
    delete: "Delete",
    down: "↓",
    end: "End",
    enter: "Enter",
    escape: "Esc",
    home: "Home",
    left: "←",
    pageDown: "PageDown",
    pageUp: "PageUp",
    right: "→",
    shift: "Shift",
    super: "Super",
    tab: "Tab",
    up: "↑",
  };
  return key
    .split("+")
    .map((part) => names[part] ?? (part.length === 1 ? part.toLocaleUpperCase() : part))
    .join("+");
}
