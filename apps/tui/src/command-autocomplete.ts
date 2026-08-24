import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from "@earendil-works/pi-tui";

import { type AdamCommandRegistry, adamCommandRegistry } from "./command-registry.js";
import { safeTerminalText } from "./safe-terminal-text.js";

type SkillCompletion = {
  readonly description: string;
  readonly name: string;
  readonly qualifiedId: string;
};

export class AdamAutocompleteProvider implements AutocompleteProvider {
  readonly triggerCharacters = ["$"];
  readonly #getProjectPaths: () => readonly string[];
  readonly #getRunActive: () => boolean;
  readonly #getSkills: () => readonly SkillCompletion[];
  readonly #registry: AdamCommandRegistry;

  constructor(options: {
    readonly getProjectPaths: () => readonly string[];
    readonly getRunActive: () => boolean;
    readonly getSkills: () => readonly SkillCompletion[];
    readonly registry?: AdamCommandRegistry;
  }) {
    this.#getProjectPaths = options.getProjectPaths;
    this.#getRunActive = options.getRunActive;
    this.#getSkills = options.getSkills;
    this.#registry = options.registry ?? adamCommandRegistry;
  }

  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { readonly force?: boolean; readonly signal: AbortSignal },
  ): Promise<AutocompleteSuggestions | null> {
    if (options.signal.aborted) {
      return Promise.resolve(null);
    }
    const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
    if (
      cursorLine === 0 &&
      beforeCursor.startsWith("/") &&
      !beforeCursor.includes(" ") &&
      !beforeCursor.includes("\t")
    ) {
      const query = beforeCursor.slice(1);
      const availableCommands = this.#registry
        .entries()
        .filter((command) =>
          this.#registry.isAvailable(command, { runActive: this.#getRunActive() }),
        );
      const prefixMatches = availableCommands.filter(
        (command) =>
          command.name.startsWith(query) ||
          command.aliases.some((alias) => alias.startsWith(query)),
      );
      const commands =
        prefixMatches.length > 0
          ? prefixMatches
          : this.#registry.suggest(query).filter((command) => availableCommands.includes(command));
      const items = commands.map<AutocompleteItem>((command) => ({
        value: `/${command.name}`,
        label: `/${command.name}`,
        description: `${command.usage} · ${command.summary}`,
      }));
      return Promise.resolve(items.length === 0 ? null : { items, prefix: beforeCursor });
    }
    const helpPrefix =
      cursorLine === 0 ? /^\/help[ \t]+([^\s]*)$/.exec(beforeCursor)?.[1] : undefined;
    if (helpPrefix !== undefined) {
      const helpItems = this.#registry
        .helpTopics()
        .filter((topic) => topic.id.startsWith(helpPrefix))
        .map<AutocompleteItem>((topic) => ({
          value: topic.id,
          label: topic.id,
          description: topic.summary,
        }));
      return Promise.resolve(
        helpItems.length === 0 ? null : { items: helpItems, prefix: helpPrefix },
      );
    }
    const skillPrefix =
      cursorLine === 0 ? /^\/skills[ \t]+([^\s]*)$/.exec(beforeCursor)?.[1] : undefined;
    if (skillPrefix !== undefined) {
      const skillItems = this.#getSkills()
        .filter((skill) => skill.qualifiedId.startsWith(skillPrefix))
        .map<AutocompleteItem>((skill) => ({
          value: skill.qualifiedId,
          label: skill.qualifiedId,
          description: safeTerminalText(skill.description),
        }));
      return Promise.resolve(
        skillItems.length === 0 ? null : { items: skillItems, prefix: skillPrefix },
      );
    }
    const mention = /(?:^|[^A-Za-z0-9_$\\])(\$([a-z0-9-]*))$/u.exec(beforeCursor);
    const mentionPrefix = mention?.[1];
    const mentionNamePrefix = mention?.[2];
    if (mentionPrefix !== undefined && mentionNamePrefix !== undefined) {
      const skillItems = this.#getSkills()
        .filter((skill) => skill.name.startsWith(mentionNamePrefix))
        .map<AutocompleteItem>((skill) => ({
          value: `$${skill.name}`,
          label: `$${skill.name}`,
          description: safeTerminalText(`${skill.qualifiedId} · ${skill.description}`),
        }));
      return Promise.resolve(
        skillItems.length === 0 ? null : { items: skillItems, prefix: mentionPrefix },
      );
    }
    if (options.force !== true) {
      return Promise.resolve(null);
    }
    const prefix = beforeCursor.match(/(?:^|\s)([^\s]*)$/)?.[1] ?? "";
    const normalizedPrefix = prefix.toLocaleLowerCase();
    const pathItems = this.#getProjectPaths()
      .filter((path) => path.toLocaleLowerCase().startsWith(normalizedPrefix))
      .map<AutocompleteItem>((path) => {
        const safePath = safeTerminalText(path);
        return { value: safePath, label: safePath };
      });
    return Promise.resolve(pathItems.length === 0 ? null : { items: pathItems, prefix });
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { readonly lines: string[]; readonly cursorLine: number; readonly cursorCol: number } {
    const completed = [...lines];
    const line = completed[cursorLine] ?? "";
    const start = Math.max(0, cursorCol - prefix.length);
    completed[cursorLine] = `${line.slice(0, start)}${item.value}${line.slice(cursorCol)}`;
    return { lines: completed, cursorLine, cursorCol: start + item.value.length };
  }
}
