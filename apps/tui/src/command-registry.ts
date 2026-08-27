/**
 * Keybinding rows adapt the effective Editor bindings exported by @earendil-works/pi-tui 0.84.2 (MIT); Adam-owned overlay and process actions remain local. See THIRD_PARTY_NOTICES.md.
 */
import { getKeybindings, type Keybinding, type KeyId, matchesKey } from "@earendil-works/pi-tui";

export type AdamCommandDefinition = {
  readonly aliases: readonly string[];
  readonly availability: "always" | "idle";
  readonly id:
    | "artifacts"
    | "clone"
    | "config"
    | "copy"
    | "diffs"
    | "extension"
    | "fork"
    | "help"
    | "history"
    | "hotkeys"
    | "instructions"
    | "mcp"
    | "model"
    | "name"
    | "new"
    | "reload"
    | "resume"
    | "session"
    | "skills"
    | "target"
    | "thinking"
    | "trust"
    | "tree";
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly extensionCommand?: {
    readonly id: string;
    readonly version: number;
  };
};

export type AdamKeybindingAction =
  | "back"
  | "exit"
  | "fork_from_target"
  | "interrupt"
  | "new_session_from_target"
  | "rename_session"
  | "save_default_target"
  | "submit"
  | "toggle_reasoning"
  | "toggle_tool_details";

export type AdamKeybindingDefinition = {
  readonly action: AdamKeybindingAction | null;
  readonly description: string;
  readonly inputs: readonly KeyId[];
  readonly keys: string;
  readonly section: "application" | "editor";
};

export type AdamHelpTopicDefinition = {
  readonly id: "commands" | "editor" | "hotkeys" | "safety";
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

export class AdamCommandRegistry {
  readonly #commands: readonly AdamCommandDefinition[];
  readonly #commandsByName: ReadonlyMap<string, AdamCommandDefinition>;

  constructor(commands: readonly AdamCommandDefinition[]) {
    const names = commands.flatMap((command) => [command.name, ...command.aliases]);
    if (new Set(names).size !== names.length) {
      throw new TypeError("Adam command names and aliases must be unique.");
    }
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

  keybinding(action: AdamKeybindingAction): AdamKeybindingDefinition {
    const binding = this.keybindings().find((candidate) => candidate.action === action);
    if (binding === undefined) {
      throw new TypeError(`The ${action} keybinding must exist.`);
    }
    return binding;
  }

  suggest(name: string, limit = 3): readonly AdamCommandDefinition[] {
    return rankSuggestions(this.#commands, name, (command) => command.name, limit);
  }
}

const builtInCommands: readonly AdamCommandDefinition[] = [
  {
    aliases: [],
    availability: "always",
    id: "artifacts",
    name: "artifacts",
    summary: "Browse bounded artifacts from the active chronology.",
    usage: "/artifacts",
  },
  {
    aliases: [],
    availability: "always",
    id: "diffs",
    name: "diffs",
    summary: "Reopen settled change previews from the active chronology.",
    usage: "/diffs",
  },
  {
    aliases: [],
    availability: "always",
    id: "copy",
    name: "copy",
    summary: "Copy the last assistant response.",
    usage: "/copy",
  },
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
    availability: "always",
    id: "thinking",
    name: "thinking",
    summary: "Choose the exact thinking level for the next prompt.",
    usage: "/thinking [level]",
  },
  {
    aliases: [],
    availability: "idle",
    id: "config",
    name: "config",
    summary: "Inspect and tighten owner-local model limits for new sessions.",
    usage: "/config [context|output|compaction <tokens|default>]",
  },
  {
    aliases: [],
    availability: "idle",
    id: "trust",
    name: "trust",
    summary: "Inspect, grant, or revoke owner-local trust for this exact project.",
    usage: "/trust [status|grant|revoke]",
  },
  {
    aliases: [],
    availability: "idle",
    id: "new",
    name: "new",
    summary: "Choose an exact target and create a new session.",
    usage: "/new",
  },
  {
    aliases: [],
    availability: "idle",
    id: "reload",
    name: "reload",
    summary: "Select one eligible project resource authority to reload.",
    usage: "/reload",
  },
  {
    aliases: [],
    availability: "idle",
    id: "resume",
    name: "resume",
    summary: "Search and open an existing project session.",
    usage: "/resume",
  },
  {
    aliases: [],
    availability: "always",
    id: "session",
    name: "session",
    summary: "Inspect authoritative session, chronology, context, and usage facts.",
    usage: "/session",
  },
  {
    aliases: [],
    availability: "idle",
    id: "tree",
    name: "tree",
    summary: "Browse complete active-chronology boundaries without mutation.",
    usage: "/tree",
  },
  {
    aliases: [],
    availability: "idle",
    id: "model",
    name: "model",
    summary: "Choose a new-session or fork target without mutating this session.",
    usage: "/model",
  },
  {
    aliases: [],
    availability: "idle",
    id: "target",
    name: "target",
    summary: "Open the same immutable exact-target transition page as /model.",
    usage: "/target",
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
    id: "clone",
    name: "clone",
    summary: "Create a child at the latest complete boundary with an empty editor.",
    usage: "/clone",
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
];

export type AdamExtensionCommandDefinition = {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly version: number;
};

export function createAdamCommandRegistry(
  extensionCommands: readonly AdamExtensionCommandDefinition[] = [],
): AdamCommandRegistry {
  return new AdamCommandRegistry([
    ...builtInCommands,
    ...extensionCommands.map(
      (command): AdamCommandDefinition => ({
        aliases: [],
        availability: "idle",
        id: "extension",
        name: command.name,
        summary: command.title,
        usage: `/${command.name}`,
        extensionCommand: { id: command.id, version: command.version },
      }),
    ),
  ]);
}

export function createAdamCommandRegistryFromContributions(
  contributions: readonly {
    readonly command?: AdamExtensionCommandDefinition | undefined;
    readonly inputSource?: { readonly id: string; readonly version: number } | undefined;
  }[],
): AdamCommandRegistry {
  return createAdamCommandRegistry(
    contributions.flatMap((contribution) =>
      contribution.command !== undefined &&
      contribution.inputSource?.id === "project_changes" &&
      contribution.inputSource.version === 1
        ? [contribution.command]
        : [],
    ),
  );
}

export const adamCommandRegistry = createAdamCommandRegistry();

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
    action: "toggle_reasoning",
    adamInputs: ["ctrl+t"],
    keys: "Ctrl+T",
    description: "Expand or collapse the active, otherwise latest, provider reasoning block",
    section: "application",
  },
  {
    action: "toggle_tool_details",
    adamInputs: ["ctrl+o"],
    keys: "Ctrl+O",
    description: "Toggle bounded authoritative tool details in the transcript",
    section: "application",
  },
  {
    action: null,
    description: "Open or accept autocomplete",
    piBindings: ["tui.input.tab"],
    section: "application",
  },
  {
    action: "rename_session",
    adamInputs: ["ctrl+r"],
    keys: "Ctrl+R",
    description: "Recover the latest eligible operation; rename the focused session in its picker",
    section: "application",
  },
  {
    action: "new_session_from_target",
    adamInputs: ["ctrl+n"],
    keys: "Ctrl+N",
    description: "Create a new session from the focused transition target",
    section: "application",
  },
  {
    action: "fork_from_target",
    adamInputs: ["ctrl+f"],
    keys: "Ctrl+F",
    description: "Fork the current boundary onto the focused target",
    section: "application",
  },
  {
    action: "save_default_target",
    adamInputs: ["ctrl+s"],
    keys: "Ctrl+S",
    description: "Save the focused exact target, or clear it when already saved",
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
  { id: "safety", label: "Safety", summary: "Permissions, trust, and isolation boundaries" },
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
