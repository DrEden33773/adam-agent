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
  readonly source:
    | { readonly type: "project"; readonly scope: string }
    | { readonly type: "user" }
    | { readonly type: "extension"; readonly extensionId: string; readonly packageVersion: string };
};

export type SkillAutocompleteIdentity = {
  readonly name: string;
  readonly qualifiedId: string;
};

export type PathAutocompleteIdentity = {
  readonly path: string;
};

type SkillAutocompleteItem = AutocompleteItem & {
  readonly adamSkill: SkillAutocompleteIdentity;
};

type PathAutocompleteItem = AutocompleteItem & {
  readonly adamPath: PathAutocompleteIdentity;
};

export function pathAutocompleteIdentity(item: AutocompleteItem): PathAutocompleteIdentity | null {
  const candidate = item as Partial<PathAutocompleteItem>;
  return candidate.adamPath?.path === undefined ? null : candidate.adamPath;
}

export function skillAutocompleteIdentity(
  item: AutocompleteItem,
): SkillAutocompleteIdentity | null {
  const candidate = item as Partial<SkillAutocompleteItem>;
  return candidate.adamSkill?.name === undefined || candidate.adamSkill.qualifiedId === undefined
    ? null
    : candidate.adamSkill;
}

export class AdamAutocompleteProvider implements AutocompleteProvider {
  readonly triggerCharacters = ["$", "@"];
  readonly #getAttachmentsAvailable: () => boolean;
  readonly #getProjectPaths: () => readonly string[];
  readonly #getRunActive: () => boolean;
  readonly #getSkills: () => readonly SkillCompletion[];
  readonly #getThinkingLevelIds: () => readonly string[];
  readonly #keyword: (text: string) => string;
  readonly #path: (text: string) => string;
  readonly #skill: (text: string) => string;
  readonly #registry: AdamCommandRegistry;

  constructor(options: {
    readonly getAttachmentsAvailable?: () => boolean;
    readonly getProjectPaths: () => readonly string[];
    readonly getRunActive: () => boolean;
    readonly getSkills: () => readonly SkillCompletion[];
    readonly getThinkingLevelIds?: () => readonly string[];
    readonly keyword?: (text: string) => string;
    readonly path?: (text: string) => string;
    readonly skill?: (text: string) => string;
    readonly registry?: AdamCommandRegistry;
  }) {
    this.#getAttachmentsAvailable = options.getAttachmentsAvailable ?? (() => true);
    this.#getProjectPaths = options.getProjectPaths;
    this.#getRunActive = options.getRunActive;
    this.#getSkills = options.getSkills;
    this.#getThinkingLevelIds = options.getThinkingLevelIds ?? (() => []);
    this.#keyword = options.keyword ?? ((text) => text);
    this.#path = options.path ?? ((text) => text);
    this.#skill = options.skill ?? ((text) => text);
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
      const availability = {
        attachmentsAvailable: this.#getAttachmentsAvailable(),
        runActive: this.#getRunActive(),
      };
      const prefixMatches = this.#registry
        .entries()
        .filter(
          (command) =>
            command.name.startsWith(query) ||
            command.aliases.some((alias) => alias.startsWith(query)),
        );
      const commands = prefixMatches.length > 0 ? prefixMatches : this.#registry.suggest(query);
      const items = commands
        .map((command, index) => ({
          command,
          index,
          reason: this.#registry.availabilityReason(command, availability),
        }))
        .sort(
          (left, right) =>
            Number(left.reason !== null) - Number(right.reason !== null) ||
            left.index - right.index,
        )
        .map<AutocompleteItem>(({ command, reason }) => ({
          value: `/${command.name}`,
          label: this.#keyword(`/${command.name}`),
          description: `${command.usage}${reason === null ? "" : ` · unavailable · ${reason}`} · ${command.summary}`,
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
          label: this.#keyword(topic.id),
          description: topic.summary,
        }));
      return Promise.resolve(
        helpItems.length === 0 ? null : { items: helpItems, prefix: helpPrefix },
      );
    }
    const argumentMatch = cursorLine === 0 ? /^\/([a-z]+)[ \t]+(.*)$/u.exec(beforeCursor) : null;
    if (argumentMatch !== null) {
      const commandName = argumentMatch[1] ?? "";
      const argumentsText = argumentMatch[2] ?? "";
      const runActive = this.#getRunActive();
      const parsed = this.#registry.parse(`/${commandName}`);
      if (
        parsed.kind !== "known" ||
        !this.#registry.isAvailable(parsed.command, {
          attachmentsAvailable: this.#getAttachmentsAvailable(),
          runActive,
        })
      ) {
        return Promise.resolve(null);
      }
      const resolution = this.#registry.argumentCompletions(commandName, argumentsText, {
        attachmentsAvailable: this.#getAttachmentsAvailable(),
        runActive,
        thinkingLevelIds: this.#getThinkingLevelIds(),
      });
      const completion = resolution.kind === "owned" ? resolution.completion : null;
      if (completion?.exact === true) {
        return Promise.resolve(null);
      }
      const skillItems =
        commandName === "skills" && !/\s/u.test(argumentsText)
          ? this.#getSkills()
              .filter((skill) => skill.qualifiedId.startsWith(argumentsText))
              .map<AutocompleteItem>((skill) => ({
                value: skill.qualifiedId,
                label: skill.qualifiedId,
                description: safeTerminalText(skill.description),
              }))
          : [];
      const items = [...(completion?.items ?? []), ...skillItems];
      if (items.length > 0) {
        return Promise.resolve({ items, prefix: completion?.prefix ?? argumentsText });
      }
      if (resolution.kind === "owned") {
        return Promise.resolve(null);
      }
    }
    const mention = /(?:^|[^A-Za-z0-9_$\\])(\$([a-z0-9-]*))$/u.exec(beforeCursor);
    const mentionPrefix = mention?.[1];
    const mentionNamePrefix = mention?.[2];
    if (mentionPrefix !== undefined && mentionNamePrefix !== undefined) {
      const skillItems = this.#getSkills()
        .filter((skill) => skill.name.startsWith(mentionNamePrefix))
        .map<SkillAutocompleteItem>((skill) => ({
          adamSkill: { name: skill.name, qualifiedId: skill.qualifiedId },
          value: `$${skill.name}`,
          label: this.#skill(`$${skill.name}`),
          description: safeTerminalText(`${skillSourceLabel(skill.source)} · ${skill.description}`),
        }));
      return Promise.resolve(
        skillItems.length === 0 ? null : { items: skillItems, prefix: mentionPrefix },
      );
    }
    const pathMention = /(?:^|\s)(@([^\s@]*))$/u.exec(beforeCursor);
    const pathPrefix = pathMention?.[1];
    const pathValuePrefix = pathMention?.[2];
    if (pathPrefix !== undefined && pathValuePrefix !== undefined) {
      const normalizedPrefix = pathValuePrefix.toLocaleLowerCase();
      const candidates = this.#getProjectPaths()
        .map((path, index) => {
          const rank = projectPathMatchRank(path, normalizedPrefix);
          return rank === null ? null : { index, path, rank };
        })
        .filter((candidate) => candidate !== null)
        .sort((left, right) => left.rank - right.rank || left.index - right.index)
        .map((candidate) => candidate.path);
      const pathItems = candidates.map<PathAutocompleteItem>((path) => {
        const safePath = safeTerminalText(path);
        const columns = projectPathColumns(safePath);
        return {
          adamPath: { path: safePath },
          value: `@${safePath}`,
          label: this.#path(`@${columns.fileName}`),
          description: columns.parentPath,
        };
      });
      return Promise.resolve(
        pathItems.length === 0 ? null : { items: pathItems, prefix: pathPrefix },
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
        return { value: safePath, label: this.#path(safePath) };
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

function projectPathColumns(path: string): {
  readonly fileName: string;
  readonly parentPath: string;
} {
  const withoutTrailingSlash = path.endsWith("/") ? path.slice(0, -1) : path;
  const separator = withoutTrailingSlash.lastIndexOf("/");
  return {
    fileName: withoutTrailingSlash.slice(separator + 1),
    parentPath: separator < 0 ? "./" : withoutTrailingSlash.slice(0, separator + 1),
  };
}

function projectPathMatchRank(path: string, query: string): number | null {
  const normalizedPath = path.toLocaleLowerCase();
  const fileName = projectPathColumns(normalizedPath).fileName;
  if (fileName.startsWith(query)) return 0;
  if (normalizedPath.startsWith(query)) return 1;
  return fuzzyMatch(normalizedPath, query) ? 2 : null;
}

function fuzzyMatch(candidate: string, query: string): boolean {
  const normalizedCandidate = candidate.toLocaleLowerCase();
  let position = 0;
  for (const character of query) {
    position = normalizedCandidate.indexOf(character, position);
    if (position < 0) return false;
    position += character.length;
  }
  return true;
}

function skillSourceLabel(source: SkillCompletion["source"]): string {
  if (source.type === "user") {
    return "user";
  }
  if (source.type === "project") {
    return `project:${source.scope}`;
  }
  return `extension:${source.extensionId}@${source.packageVersion}`;
}
