import type {
  AgentRoleDefinitionInput,
  AgentRoleMutation,
  AgentRoleTypeDisplay,
  AgentTypesDisplay,
  CommandReceipt,
} from "@adam-agent/presentation";
import {
  type Component,
  Input,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  SelectList,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { safeTerminalText } from "./safe-terminal-text.js";
import type { AdamTuiTheme } from "./theme.js";

const steps = [
  "Name",
  "Description",
  "Base",
  "Tools",
  "Skills",
  "Web",
  "Context",
  "Target",
  "Thinking",
  "Limits",
  "Source",
  "Preview",
] as const;
const readTools = [
  "read_file",
  "search_repository",
  "activate_skill",
  "read_skill_resource",
  "report_to_parent",
  "request_parent_input",
];
const webTools = ["web_fetch", "web_search", "web_open", "web_find"];

/** A finite Owner editor; all writes and catalog truth remain in the lifecycle. */
export class AgentTypes implements Component {
  #catalog: AgentTypesDisplay;
  #selected = 0;
  #notice = "";
  #pending = false;
  #scroll = 0;
  #maximumScroll = 0;
  #diagnostics = false;
  #step: number | undefined;
  #input = new Input();
  #list: SelectList | undefined;
  #fields: AgentRoleDefinitionInput = { name: "", description: "", base: "explore" };
  #source: "project" | "user" = "project";
  #original: AgentRoleTypeDisplay | undefined;
  #toggle: AgentRoleMutation | undefined;
  constructor(
    private readonly options: {
      readonly catalog: AgentTypesDisplay;
      readonly theme: AdamTuiTheme;
      readonly maximumLines: () => number;
      readonly onChange: () => void;
      readonly onClose: () => void;
      readonly onReload: () => Promise<AgentTypesDisplay>;
      readonly onWrite: (mutation: AgentRoleMutation) => Promise<CommandReceipt>;
    },
  ) {
    this.#catalog = options.catalog;
  }

  #change(): void {
    this.options.onChange();
  }
  #begin(original?: AgentRoleTypeDisplay, eject = false): void {
    this.#original = original;
    this.#fields =
      original === undefined
        ? {
            name: "",
            description: "",
            base: "explore",
            skills: true,
            web: false,
            context_mode: "current_request",
          }
        : {
            name: eject ? original.name : `${original.name} copy`,
            description: original.description,
            base: original.base,
            tools: [...original.tools],
            skills: original.skills ?? true,
            web: original.web,
            context_mode: original.contextMode ?? "current_request",
            ...(original.model === undefined ? {} : { model: original.model }),
            ...(original.thinking === undefined ? {} : { thinking: original.thinking }),
            ...(original.limits === undefined ? {} : { limits: { ...original.limits } }),
            ...(eject ? { overrides: original.qualifiedId } : {}),
          };
    this.#source = this.#catalog.sources.some(
      (source) => source.kind === "project" && source.writable,
    )
      ? "project"
      : "user";
    this.#notice = "";
    this.#showStep(eject ? 10 : 0);
  }
  #showStep(step: number): void {
    this.#step = step;
    this.#scroll = 0;
    this.#maximumScroll = 0;
    this.#list = undefined;
    if (step < 2) {
      this.#input.setValue(step === 0 ? this.#fields.name : this.#fields.description);
      this.#input.onSubmit = (value) => {
        const text = value.trim();
        if (!text) {
          this.#notice = "Enter a nonempty value.";
          this.#change();
          return;
        }
        if (step === 0) this.#fields.name = text;
        else this.#fields.description = text;
        this.#showStep(step + 1);
      };
    } else if (step < 11) {
      const choices: { value: string; label: string; description: string }[] =
        step === 2
          ? [
              {
                value: "explore",
                label: "Explore",
                description: "Repository reads and Skills; no Web.",
              },
              {
                value: "research",
                label: "Research",
                description: "Repository reads, Skills and Main's permitted Web.",
              },
            ]
          : step === 3
            ? [
                {
                  value: "base",
                  label: "Base tools",
                  description: "All tools allowed by the selected base.",
                },
                {
                  value: "files",
                  label: "Read files only",
                  description: "Only read_file; no Skills or Web tools.",
                },
                {
                  value: "repository",
                  label: "Repository tools",
                  description: "read_file and search_repository.",
                },
              ]
            : step === 4
              ? [
                  {
                    value: "full",
                    label: "Full frozen Skill catalog",
                    description: "Independent activation; no additional effects.",
                  },
                  {
                    value: "none",
                    label: "No Skills",
                    description: "Remove Skill activation and resource tools.",
                  },
                ]
              : step === 5
                ? [
                    {
                      value: "base",
                      label: this.#fields.base === "research" ? "Effective Main Web" : "No Web",
                      description: "Always subject to Main's current permission ceiling.",
                    },
                    ...(this.#fields.base === "research"
                      ? [{ value: "none", label: "No Web", description: "Remove all Web tools." }]
                      : []),
                  ]
                : step === 6
                  ? [
                      {
                        value: "current_request",
                        label: "Current request",
                        description:
                          "Current request and explicit task; no automatic earlier history.",
                      },
                      {
                        value: "task",
                        label: "Task only",
                        description: "Only the explicit delegated task.",
                      },
                    ]
                  : step === 7
                    ? [
                        {
                          value: "inherit",
                          label: "Inherit Main target and thinking",
                          description:
                            "Freeze Main's exact target and effective thinking at admission.",
                        },
                        ...this.#catalog.targets.map((target) => ({
                          value: target.targetId,
                          label: target.label,
                          description: "Certified target; use its supported default thinking.",
                        })),
                      ]
                    : step === 8
                      ? [
                          {
                            value: "inherit",
                            label:
                              this.#fields.model === undefined
                                ? "Inherit effective thinking"
                                : "Target default thinking",
                            description: "Resolve against the exact target at admission.",
                          },
                          ...(
                            this.#catalog.targets.find(
                              (target) => target.targetId === this.#fields.model,
                            )?.thinkingLevels ?? []
                          ).map((level) => ({
                            value: level.id,
                            label: level.label,
                            description: "Supported by the selected certified target.",
                          })),
                        ]
                      : step === 9
                        ? [
                            {
                              value: "base",
                              label: "Base and envelope limits",
                              description: "No additional limit; never increases Main's ceiling.",
                            },
                            {
                              value: "4",
                              label: "At most 4 turns",
                              description: "Further limit each child attempt.",
                            },
                            {
                              value: "1",
                              label: "At most 1 turn",
                              description: "A single model step.",
                            },
                          ]
                        : [
                            {
                              value: "project",
                              label: "Trusted project",
                              description: ".agents/agents; shareable project definition.",
                            },
                            {
                              value: "user",
                              label: "User",
                              description: "Adam XDG agents directory; local Owner configuration.",
                            },
                          ];
      const list = new SelectList(
        choices.map((choice) => ({
          ...choice,
          label: safeTerminalText(choice.label),
          description: safeTerminalText(choice.description),
        })),
        6,
        this.options.theme.editor.selectList,
      );
      list.onSelect = (item) => {
        const value = item.value;
        if (step === 2) this.#fields.base = value === "research" ? "research" : "explore";
        if (step === 3)
          this.#fields.tools =
            value === "files"
              ? ["read_file"]
              : value === "repository"
                ? ["read_file", "search_repository"]
                : [...readTools, ...(this.#fields.base === "research" ? webTools : [])];
        if (step === 4) {
          this.#fields.skills = value === "full";
          if (value === "none")
            this.#fields.tools = (this.#fields.tools ?? []).filter(
              (tool) => tool !== "activate_skill" && tool !== "read_skill_resource",
            );
        }
        if (step === 5) {
          this.#fields.web = value === "base" && this.#fields.base === "research";
          if (!this.#fields.web)
            this.#fields.tools = (this.#fields.tools ?? []).filter(
              (tool) => !webTools.includes(tool),
            );
        }
        if (step === 6) this.#fields.context_mode = value === "task" ? "task" : "current_request";
        if (step === 7) {
          delete this.#fields.thinking;
          if (value === "inherit") delete this.#fields.model;
          else this.#fields.model = value;
        }
        if (step === 8) {
          if (value === "inherit") delete this.#fields.thinking;
          else this.#fields.thinking = value;
        }
        if (step === 9) {
          if (value === "base") delete this.#fields.limits;
          else this.#fields.limits = { maxTurns: Number(value) };
        }
        if (step === 10) this.#source = value === "user" ? "user" : "project";
        this.#showStep(step + 1);
      };
      list.onCancel = () => {
        this.#step = undefined;
        this.#change();
      };
      this.#list = list;
    }
    this.#change();
  }
  async #write(mutation: AgentRoleMutation): Promise<void> {
    this.#pending = true;
    this.#change();
    try {
      const receipt = await this.options.onWrite(mutation);
      if (receipt.status === "rejected") {
        this.#notice = receipt.message;
        return;
      }
      this.#catalog = await this.options.onReload();
      const id =
        mutation.action === "create"
          ? `${mutation.source}:${encodeURIComponent(mutation.fields.name)}`
          : mutation.qualifiedId;
      this.#selected = Math.max(
        0,
        this.#catalog.definitions.findIndex((role) => role.qualifiedId === id),
      );
      const role = this.#catalog.definitions[this.#selected];
      this.#notice = `${mutation.action === "create" ? "Saved" : mutation.enabled ? "Enabled" : "Disabled"} ${role?.name ?? "role"}`;
      this.#step = undefined;
      this.#toggle = undefined;
    } catch (error) {
      this.#notice = error instanceof Error ? error.message : "Role change failed.";
    } finally {
      this.#pending = false;
      this.#change();
    }
  }
  handleInput(data: string): void {
    if (isKeyRelease(data) || this.#pending) return;
    if (matchesKey(data, "escape") && !isKeyRepeat(data)) {
      if (this.#diagnostics) {
        this.#diagnostics = false;
        this.#scroll = 0;
        this.#change();
        return;
      }
      if (this.#step !== undefined || this.#toggle !== undefined) {
        this.#step = undefined;
        this.#toggle = undefined;
        this.#change();
      } else this.options.onClose();
      return;
    }
    if (
      (this.#step === 11 || this.#diagnostics) &&
      (matchesKey(data, "down") || matchesKey(data, "up"))
    ) {
      this.#scroll = Math.max(
        0,
        Math.min(this.#maximumScroll, this.#scroll + (matchesKey(data, "down") ? 1 : -1)),
      );
      this.#change();
      return;
    }
    if (this.#diagnostics) return;
    if (this.#toggle !== undefined) {
      if (matchesKey(data, "enter") && !isKeyRepeat(data)) void this.#write(this.#toggle);
      return;
    }
    if (this.#step !== undefined) {
      if (this.#step < 2) this.#input.handleInput(data);
      else if (this.#step < 11) this.#list?.handleInput(data);
      else if (
        matchesKey(data, "enter") &&
        !isKeyRepeat(data) &&
        this.#scroll === this.#maximumScroll
      )
        void this.#write({
          action: "create",
          source: this.#source,
          fields: this.#fields,
          instructions: this.#original?.instructions ?? "",
          ...(this.#original === undefined
            ? {}
            : {
                original: {
                  qualifiedId: this.#original.qualifiedId,
                  definitionDigest: this.#original.definitionDigest,
                },
              }),
        });
      this.#change();
      return;
    }
    const role = this.#catalog.definitions[this.#selected];
    if (matchesKey(data, "down"))
      this.#selected = Math.min(this.#catalog.definitions.length - 1, this.#selected + 1);
    else if (matchesKey(data, "up")) this.#selected = Math.max(0, this.#selected - 1);
    else if (!isKeyRepeat(data)) {
      if (data === "!") {
        this.#diagnostics = true;
        this.#scroll = 0;
      } else if (matchesKey(data, "n")) this.#begin();
      else if (matchesKey(data, "d") && role !== undefined) this.#begin(role);
      else if (matchesKey(data, "e") && role?.source?.kind === "builtin") this.#begin(role, true);
      else if (data === " " && role !== undefined)
        this.#toggle = {
          action: "toggle",
          qualifiedId: role.qualifiedId,
          definitionDigest: role.definitionDigest,
          enabled: !role.enabled,
        };
      else if (matchesKey(data, "r")) {
        this.#pending = true;
        void this.options
          .onReload()
          .then(
            (catalog) => {
              this.#catalog = catalog;
              this.#selected = Math.min(
                this.#selected,
                Math.max(0, catalog.definitions.length - 1),
              );
              this.#notice = "Reloaded; existing threads keep their frozen definitions.";
            },
            (error) => {
              this.#notice = String(error);
            },
          )
          .finally(() => {
            this.#pending = false;
            this.#change();
          });
      }
    }
    this.#change();
  }
  invalidate(): void {
    this.#input.invalidate();
    this.#list?.invalidate();
  }
  render(width: number): string[] {
    const role = this.#catalog.definitions[this.#selected];
    const heading = this.#diagnostics
      ? "Agent types · Diagnostics"
      : this.#toggle !== undefined
        ? `Confirm ${this.#toggle.action === "toggle" && this.#toggle.enabled ? "enable" : "disable"} ${role?.name}`
        : this.#step === undefined
          ? "Agent types"
          : `Agent types · ${steps[this.#step]}`;
    let content: string[];
    if (this.#diagnostics)
      content =
        this.#catalog.diagnostics.length === 0
          ? ["No diagnostics."]
          : this.#catalog.diagnostics.map(
              (diagnostic) => `${diagnostic.source}: ${diagnostic.message}`,
            );
    else if (this.#toggle !== undefined)
      content = [
        "Applies to future admissions. Existing threads retain their definitions.",
        "Enter confirm · Esc cancel",
      ];
    else if (this.#step !== undefined)
      content =
        this.#step < 2
          ? this.#input.render(width)
          : this.#step < 11
            ? (this.#list?.render(width) ?? [])
            : [
                `${this.#fields.name} · ${this.#fields.description}`,
                `Source: ${this.#catalog.sources.find((source) => source.kind === this.#source)?.path ?? this.#source}/${encodeURIComponent(this.#fields.name)}.md`,
                `Base: ${this.#fields.base} · Web: ${this.#fields.web ? "effective Main" : "none"}`,
                `Tools: ${this.#fields.tools?.join(", ") ?? "base tools"}`,
                `Skills: ${this.#fields.skills ? "frozen catalog" : "none"} · Context: ${this.#fields.context_mode ?? "current_request"}`,
                `Target: ${this.#fields.model ?? "inherit Main"} · Thinking: ${this.#fields.thinking ?? "inherited or target default"}`,
                `Limits: ${this.#fields.limits?.maxTurns ?? "base"} turns · ${this.#fields.limits?.maxTokens ?? "envelope"} tokens`,
                ...(this.#fields.overrides === undefined
                  ? []
                  : [`Exact override: ${this.#fields.overrides}`]),
                ...(this.#original?.instructions
                  ? [`Instructions: ${this.#original.instructions}`]
                  : []),
                "Enter save atomically · Esc cancel",
              ];
    else {
      const capacity = Math.max(1, this.options.maximumLines() - 10);
      const start = Math.max(0, this.#selected - capacity + 1);
      content = [
        "n create · d duplicate · e eject built-in · Space enable/disable · r Reload · ! diagnostics · Esc",
        ...this.#catalog.definitions
          .slice(start, start + capacity)
          .map(
            (entry, index) =>
              `${index + start === this.#selected ? "●" : "○"} ${entry.name} · ${entry.enabled ? (entry.available ? "enabled" : "shadowed") : "disabled"} · ${entry.source?.kind ?? "builtin"}`,
          ),
        ...(role === undefined
          ? []
          : [
              role.description,
              `Source: ${role.source?.path ?? role.qualifiedId}`,
              `Tools: ${role.tools.join(", ")}`,
              `Skills: ${role.skills ? "frozen catalog" : "none"} · Web: ${role.web ? "effective Main" : "none"}`,
              `Target: ${role.model ?? "inherit Main"} · ${role.thinking ?? "effective thinking"}`,
            ]),
        ...this.#catalog.diagnostics
          .slice(0, 2)
          .map((diagnostic) => `! ${diagnostic.source}: ${diagnostic.message}`),
      ];
    }
    if (this.#step === 11 || this.#diagnostics) {
      const lines = content.flatMap((line) =>
        wrapTextWithAnsi(safeTerminalText(line), Math.max(1, width)),
      );
      const maximum = Math.max(1, this.options.maximumLines() - 3);
      this.#maximumScroll = Math.max(0, lines.length - maximum);
      this.#scroll = Math.min(this.#scroll, this.#maximumScroll);
      return [
        this.options.theme.toolTitle(safeTerminalText(heading)),
        ...lines.slice(this.#scroll, this.#scroll + maximum),
        this.options.theme.muted(
          this.#scroll < this.#maximumScroll
            ? "↓ review remaining details · Esc cancel"
            : this.#diagnostics
              ? "↑ scroll · Esc back"
              : "Enter save atomically · ↑ scroll · Esc cancel",
        ),
        this.options.theme.muted(safeTerminalText(this.#notice)),
      ].map((line) => truncateToWidth(line, width));
    }
    return [
      this.options.theme.toolTitle(safeTerminalText(heading)),
      ...(this.#step === undefined || this.#step === 11
        ? content.map((line) => safeTerminalText(line).replace(/[\r\n]/gu, " "))
        : content),
      this.options.theme.muted(safeTerminalText(this.#pending ? "Saving…" : this.#notice)),
    ].map((line) => truncateToWidth(line, width));
  }
}
