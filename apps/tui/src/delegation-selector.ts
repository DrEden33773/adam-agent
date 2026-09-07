import type {
  ManagedDelegationContext,
  ManagedDelegationEnvelope,
  ManagedDelegationLimits,
  ManagedDelegationMessage,
} from "@adam-agent/presentation";
import {
  type Component,
  Input,
  matchesKey,
  SelectList,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { safeTerminalText } from "./safe-terminal-text.js";
import type { AdamTuiTheme } from "./theme.js";

type NumericLimit =
  | "budgetTokens"
  | "aggregateTokens"
  | "threadTokens"
  | "running"
  | "queued"
  | "sessionTokens";

export class DelegationSelector implements Component {
  #list: SelectList;
  #envelope: ManagedDelegationEnvelope;
  #context: ManagedDelegationContext;
  #selected = new Set<number>();
  #page: "review" | "context" | "messages" | "skills" | "limits" | "identity" | "custom" = "review";
  #pending = false;
  #notice = "";
  #description: string;
  #descriptionInput: Input | undefined;
  #numericInput: Input | undefined;
  #numericField: NumericLimit = "aggregateTokens";
  #skills: readonly string[];
  readonly #requestedSkills: readonly string[];
  constructor(
    private readonly options: {
      readonly description: string;
      readonly envelope: ManagedDelegationEnvelope;
      readonly messages?: readonly ManagedDelegationMessage[];
      readonly canChangeMode?: boolean;
      readonly theme: AdamTuiTheme;
      readonly onConfirm: (
        envelope: ManagedDelegationEnvelope,
        context: ManagedDelegationContext,
        skills: readonly string[],
      ) => void | Promise<void>;
      readonly onCancel: () => void | Promise<void>;
      readonly onContext?: (
        context: ManagedDelegationContext,
        skills: readonly string[],
        source: "context" | "skills",
      ) => Promise<ManagedDelegationEnvelope>;
      readonly onChange?: () => void;
      readonly onDescription?: (
        description: string,
        context: ManagedDelegationContext,
        skills: readonly string[],
      ) => Promise<ManagedDelegationEnvelope>;
      readonly onLimits?: (
        limits: ManagedDelegationLimits,
        context: ManagedDelegationContext,
        skills: readonly string[],
      ) => Promise<ManagedDelegationEnvelope>;
    },
  ) {
    this.#envelope = options.envelope;
    this.#description = options.description;
    this.#skills = options.envelope.skills;
    this.#requestedSkills = options.envelope.skills;
    this.#context =
      options.envelope.context === "task" ? { mode: "task" } : { mode: "current_request" };
    this.#list = this.#createList();
  }
  #createList(): SelectList {
    const envelope = this.#envelope;
    const lane = envelope.policy[envelope.mode === "background" ? "background" : "reserved"];
    const items =
      this.#page === "review"
        ? [
            {
              value: "confirm",
              label: "Confirm delegation",
              description: "Start this described child.",
            },
            { value: "cancel", label: "Cancel", description: "Keep the draft." },
            ...(this.options.onContext !== undefined && this.#requestedSkills.length > 0
              ? [
                  {
                    value: "skills",
                    label: "Requested Skills",
                    description: "Remove optional pre-activations.",
                  },
                ]
              : []),
            ...(this.options.onContext === undefined
              ? []
              : [
                  {
                    value: "context",
                    label: "Context sharing",
                    description: "Choose the exact parent context.",
                  },
                ]),
            ...(this.options.onLimits === undefined
              ? []
              : [
                  {
                    value: "limits",
                    label: "Execution and limits",
                    description: "Choose within current authority.",
                  },
                ]),
            {
              value: "identity",
              label: "Exact grant",
              description: "Inspect the complete ID and digest.",
            },
            ...(this.options.onDescription === undefined
              ? []
              : [
                  {
                    value: "description",
                    label: "Edit description",
                    description: "Name the work in up to 256 UTF-8 bytes.",
                  },
                ]),
          ]
        : this.#page === "identity"
          ? [
              {
                value: "back",
                label: "Back to delegation",
                description: "Review this exact grant.",
              },
            ]
          : this.#page === "custom"
            ? (envelope.version === 2
                ? this.options.canChangeMode === false
                  ? (["running", "queued"] as const)
                  : (["budgetTokens", "running", "queued"] as const)
                : ([
                    "aggregateTokens",
                    "threadTokens",
                    "running",
                    "queued",
                    "sessionTokens",
                  ] as const)
              ).map((field) => {
                const bound = this.#numericBound(field);
                return {
                  value: field,
                  label: bound.label,
                  description: `Current ${field === "budgetTokens" ? (envelope.taskBudget?.mode === "limited" ? envelope.taskBudget.grants.reduce((sum, grant) => sum + grant.tokens, 0) : "unbudgeted") : envelope[field]}; range ${bound.min}–${bound.max}`,
                };
              })
            : this.#page === "limits"
              ? [
                  ...(this.options.canChangeMode === false
                    ? []
                    : [
                        {
                          value: "background",
                          label: "Background",
                          description: "Continue working in Main.",
                        },
                      ]),
                  ...(envelope.threads === 1 && this.options.canChangeMode !== false
                    ? [
                        {
                          value: "foreground",
                          label: "Foreground",
                          description: "Join one child execution.",
                        },
                      ]
                    : []),
                  ...(envelope.version === 2
                    ? this.options.canChangeMode === false
                      ? []
                      : [
                          {
                            value: "unbudgeted",
                            label: "No cumulative budget",
                            description: "Track usage without a task ceiling.",
                          },
                        ]
                    : [1, 2, 4]
                        .filter(
                          (n) =>
                            n * (envelope.policy.threadTokens ?? 0) <=
                            Math.min(envelope.policy.batchTokens ?? 0, envelope.sessionTokens ?? 0),
                        )
                        .map((n) => ({
                          value: `tokens:${n * (envelope.policy.threadTokens ?? 0)}`,
                          label: `Aggregate ${n}x`,
                          description: `${n * (envelope.policy.threadTokens ?? 0)} tokens`,
                        }))),
                  ...Array.from({ length: lane.running }, (_, i) => i + 1)
                    .filter((running) => envelope.threads - running <= lane.queued)
                    .map((running) => ({
                      value: `running:${running}`,
                      label: `Running ${running}`,
                      description: `Range 1–${lane.running}; queued ${Math.max(0, envelope.threads - running)} (0–${lane.queued})`,
                    })),
                  ...(envelope.version === 2
                    ? []
                    : [0.25, 0.5, 1].map((n) => ({
                        value: `thread:${Math.max(1, Math.floor(n * (envelope.policy.threadTokens ?? 0)))}`,
                        label: `Thread ${n}x`,
                        description: `${Math.max(1, Math.floor(n * (envelope.policy.threadTokens ?? 0)))} tokens`,
                      }))),
                  {
                    value: "custom",
                    label: "Custom limits",
                    description: "Enter an integer within the displayed range.",
                  },
                ]
              : this.#page === "context"
                ? [
                    {
                      value: "current_request",
                      label: "Current request",
                      description: "Only the current submitted request.",
                    },
                    { value: "task", label: "Task only", description: "Only the delegated task." },
                    {
                      value: "selected_messages",
                      label: "Selected messages",
                      description: "Choose exact earlier parent messages.",
                    },
                  ]
                : this.#page === "skills"
                  ? [
                      {
                        value: "done",
                        label: "Use selected Skills",
                        description: `${this.#skills.length} pre-activations`,
                      },
                      ...this.#requestedSkills.map((id) => ({
                        value: id,
                        label: `${this.#skills.includes(id) ? "[x]" : "[ ]"} ${id}`,
                        description: "Optional child pre-activation",
                      })),
                    ]
                  : [
                      {
                        value: "done",
                        label: "Use selected messages",
                        description: `${this.#selected.size} selected`,
                      },
                      ...(this.options.messages ?? []).map((message) => ({
                        value: String(message.sequence),
                        label: `${this.#selected.has(message.sequence) ? "[x]" : "[ ]"} ${message.role} ${message.sequence}`,
                        description: message.text.replace(/\s+/gu, " "),
                      })),
                    ];
    const list = new SelectList(
      items.map((item) => ({
        ...item,
        label: safeTerminalText(item.label),
        description: safeTerminalText(item.description),
      })),
      8,
      this.options.theme.editor.selectList,
    );
    list.onCancel = () => {
      if (this.#page === "review") this.#decide(false);
      else {
        this.#page = "review";
        this.#list = this.#createList();
      }
    };
    list.onSelect = (item) => {
      if (this.#page === "review") {
        if (item.value === "confirm") this.#decide(true);
        else if (item.value === "cancel") this.#decide(false);
        else if (item.value === "description") {
          this.#descriptionInput = new Input();
          this.#descriptionInput.setValue(this.#description);
          this.#descriptionInput.onSubmit = (description) => {
            if (this.options.onDescription === undefined) return;
            this.#update(
              this.options
                .onDescription(description.trim(), this.#context, this.#skills)
                .then((envelope) => {
                  this.#description = description.trim();
                  this.#descriptionInput = undefined;
                  return envelope;
                }),
              "Description updated.",
            );
          };
        } else {
          this.#page =
            item.value === "skills"
              ? "skills"
              : item.value === "limits"
                ? "limits"
                : item.value === "identity"
                  ? "identity"
                  : "context";
          this.#list = this.#createList();
        }
      } else if (this.#page === "identity") {
        this.#page = "review";
        this.#list = this.#createList();
      } else if (this.#page === "custom") {
        const field = item.value as NumericLimit;
        this.#numericField = field;
        this.#numericInput = new Input();
        this.#numericInput.setValue(
          String(
            field === "budgetTokens"
              ? envelope.taskBudget?.mode === "limited"
                ? envelope.taskBudget.grants.reduce((sum, grant) => sum + grant.tokens, 0)
                : "unbudgeted"
              : envelope[field],
          ),
        );
        this.#numericInput.onSubmit = (raw) => {
          const value = Number(raw);
          const bound = this.#numericBound(field);
          if (
            !/^\d+$/u.test(raw) ||
            !Number.isSafeInteger(value) ||
            value < bound.min ||
            value > bound.max
          ) {
            this.#notice = `Enter an integer from ${bound.min} to ${bound.max}.`;
            return;
          }
          if (this.options.onLimits === undefined) return;
          this.#update(
            this.options
              .onLimits({ ...this.#limits(), [field]: value }, this.#context, this.#skills)
              .then((updated) => {
                this.#numericInput = undefined;
                return updated;
              }),
            "Limits updated.",
          );
        };
      } else if (this.#page === "limits") {
        if (item.value === "custom") {
          this.#page = "custom";
          this.#list = this.#createList();
          return;
        }
        const limits: ManagedDelegationLimits = {
          mode: envelope.mode,
          running: envelope.running,
          queued: envelope.queued,
          aggregateTokens: envelope.aggregateTokens,
          threadTokens: envelope.threadTokens,
          sessionTokens: envelope.sessionTokens,
        };
        const [field, raw] = item.value.split(":");
        const update: ManagedDelegationLimits =
          item.value === "unbudgeted"
            ? { budgetTokens: null }
            : field === "tokens"
              ? { aggregateTokens: Number(raw) }
              : field === "thread"
                ? { threadTokens: Number(raw) }
                : field === "running"
                  ? { running: Number(raw), queued: Math.max(0, envelope.threads - Number(raw)) }
                  : {
                      mode: item.value === "foreground" ? "foreground" : "background",
                      running: Math.min(
                        envelope.threads,
                        envelope.policy[item.value === "foreground" ? "reserved" : "background"]
                          .running,
                      ),
                      queued: Math.max(
                        0,
                        envelope.threads -
                          envelope.policy[item.value === "foreground" ? "reserved" : "background"]
                            .running,
                      ),
                    };
        if (this.options.onLimits !== undefined)
          this.#update(
            this.options.onLimits({ ...limits, ...update }, this.#context, this.#skills),
            "Limits updated.",
          );
      } else if (this.#page === "skills") {
        if (item.value === "done") this.#updateContext(this.#context, "skills");
        else {
          this.#skills = this.#skills.includes(item.value)
            ? this.#skills.filter((id) => id !== item.value)
            : [...this.#skills, item.value];
          this.#list = this.#createList();
          this.#list.setSelectedIndex(items.findIndex((entry) => entry.value === item.value));
        }
      } else if (this.#page === "context") {
        if (item.value === "selected_messages") {
          this.#page = "messages";
          this.#list = this.#createList();
        } else this.#updateContext({ mode: item.value === "task" ? "task" : "current_request" });
      } else if (item.value === "done") {
        if (this.#selected.size === 0) {
          this.#notice = "Select at least one message.";
          return;
        }
        this.#updateContext({
          mode: "selected_messages",
          messages: (this.options.messages ?? [])
            .filter((message) => this.#selected.has(message.sequence))
            .map(({ sequence, digest }) => ({ sequence, digest })),
        });
      } else {
        const sequence = Number(item.value);
        if (this.#selected.has(sequence)) this.#selected.delete(sequence);
        else this.#selected.add(sequence);
        this.#list = this.#createList();
        this.#list.setSelectedIndex(items.findIndex((entry) => entry.value === item.value));
      }
    };
    return list;
  }
  #decide(allow: boolean): void {
    this.#pending = true;
    this.#notice = allow ? "Submitting allow decision…" : "Submitting deny decision…";
    this.options.onChange?.();
    void Promise.resolve()
      .then(() =>
        allow
          ? this.options.onConfirm(this.#envelope, this.#context, this.#skills)
          : this.options.onCancel(),
      )
      .catch((error: unknown) => {
        this.#notice = error instanceof Error ? error.message : "The decision could not be saved.";
      })
      .finally(() => {
        this.#pending = false;
        this.options.onChange?.();
      });
  }
  #updateContext(
    context: ManagedDelegationContext,
    source: "context" | "skills" = "context",
  ): void {
    if (this.options.onContext === undefined) return;
    this.#update(
      this.options.onContext(context, this.#skills, source).then((envelope) => {
        this.#context = context;
        return envelope;
      }),
      "Context updated.",
    );
  }
  #limits(): ManagedDelegationLimits {
    const { mode, running, queued, aggregateTokens, threadTokens, sessionTokens } = this.#envelope;
    return {
      mode,
      running,
      queued,
      aggregateTokens,
      threadTokens,
      sessionTokens,
      ...(this.#envelope.version === 2 && this.options.canChangeMode !== false
        ? {
            budgetTokens:
              this.#envelope.taskBudget?.mode === "limited"
                ? this.#envelope.taskBudget.grants.reduce((sum, grant) => sum + grant.tokens, 0)
                : null,
          }
        : {}),
    };
  }
  #numericBound(field: NumericLimit): { label: string; min: number; max: number } {
    const envelope = this.#envelope;
    const lane = envelope.policy[envelope.mode === "background" ? "background" : "reserved"];
    switch (field) {
      case "budgetTokens":
        return { label: "Task budget tokens", min: 1, max: Number.MAX_SAFE_INTEGER };
      case "aggregateTokens":
        return {
          label: "Aggregate tokens",
          min: 1,
          max: Math.min(envelope.policy.batchTokens ?? 0, envelope.sessionTokens ?? 0),
        };
      case "threadTokens":
        return { label: "Thread tokens", min: 1, max: envelope.policy.threadTokens ?? 0 };
      case "running":
        return {
          label: "Running slots",
          min: Math.max(1, envelope.threads - envelope.queued),
          max: lane.running,
        };
      case "queued":
        return {
          label: "Queued slots",
          min: Math.max(0, envelope.threads - envelope.running),
          max: lane.queued,
        };
      case "sessionTokens":
        return {
          label: "Session ceiling",
          min: envelope.aggregateTokens ?? 1,
          max: this.options.envelope.sessionTokens ?? 0,
        };
    }
  }
  #update(update: Promise<ManagedDelegationEnvelope>, notice: string): void {
    this.#pending = true;
    this.#notice = "Preparing exact grant…";
    void update
      .then((envelope) => {
        this.#envelope = envelope;
        this.#page = "review";
        this.#list = this.#createList();
        this.#notice = notice;
      })
      .catch((error: unknown) => {
        this.#notice = error instanceof Error ? error.message : "Context is unavailable.";
      })
      .finally(() => {
        this.#pending = false;
        this.options.onChange?.();
      });
  }
  handleInput(data: string): void {
    if (this.#pending) return;
    if (this.#numericInput !== undefined) {
      if (matchesKey(data, "escape")) this.#numericInput = undefined;
      else this.#numericInput.handleInput(data);
    } else if (this.#descriptionInput !== undefined) {
      if (matchesKey(data, "escape")) this.#descriptionInput = undefined;
      else this.#descriptionInput.handleInput(data);
    } else this.#list.handleInput(data);
  }
  invalidate(): void {
    this.#list.invalidate();
  }
  render(width: number): string[] {
    const { theme } = this.options;
    if (this.#numericInput !== undefined) {
      const bound = this.#numericBound(this.#numericField);
      return [
        theme.toolTitle(`Custom ${bound.label.toLowerCase()}`),
        `Range ${bound.min}–${bound.max}`,
        ...this.#numericInput.render(width),
        truncateToWidth(safeTerminalText(this.#notice), width),
        "Enter apply · Esc back",
      ];
    }
    if (this.#descriptionInput !== undefined)
      return [
        theme.toolTitle("Edit description"),
        ...this.#descriptionInput.render(width),
        truncateToWidth(safeTerminalText(this.#notice), width),
        "Enter apply · Esc back",
      ];
    const envelope = this.#envelope;
    if (this.#page === "identity") {
      const wrap = (value: string) =>
        Array.from({ length: Math.ceil(value.length / width) }, (_, i) =>
          value.slice(i * width, (i + 1) * width),
        );
      return [
        theme.toolTitle("Exact grant"),
        ...wrap(`ID: ${envelope.id}`),
        ...wrap(`Digest: ${envelope.digest}`),
        ...wrap(`Policy: ${envelope.policyDigest}`),
        ...this.#list.render(width),
      ];
    }
    const context =
      envelope.context === "task"
        ? "Task only"
        : envelope.context === "current_request"
          ? "Current request"
          : `${this.#selected.size} selected messages`;
    return [
      theme.toolTitle(
        this.#page === "review"
          ? "Delegation"
          : this.#page === "context"
            ? "Context sharing"
            : this.#page === "skills"
              ? "Requested Skills"
              : this.#page === "custom"
                ? "Custom limits"
                : this.#page === "limits"
                  ? "Execution and limits"
                  : "Select parent messages",
      ),
      truncateToWidth(safeTerminalText(this.#description), width),
      truncateToWidth(
        `${envelope.mode} · ${envelope.threads} thread · ${envelope.running} running`,
        width,
      ),
      truncateToWidth(
        `${envelope.taskBudget === undefined ? `${envelope.aggregateTokens} tokens` : envelope.taskBudget.mode === "unbudgeted" ? "No cumulative budget" : `${envelope.taskBudget.grants.reduce((sum, grant) => sum + grant.tokens, 0)} task tokens shared by all members`} · ${context}`,
        width,
      ),
      truncateToWidth(
        `Queued ${envelope.queued}${envelope.version === 1 ? ` · Thread ${envelope.threadTokens}` : ""}`,
        width,
      ),
      truncateToWidth(
        envelope.version === 1
          ? `Session ceiling ${envelope.sessionTokens}`
          : "Budget applies to this task and its continuations",
        width,
      ),
      ...envelope.skills.map((id) => truncateToWidth(`Skill: ${safeTerminalText(id)}`, width)),
      "",
      ...this.#list.render(width),
      ...(this.#notice ? [truncateToWidth(safeTerminalText(this.#notice), width)] : []),
      truncateToWidth(theme.muted("Enter choose · Esc cancel"), width),
    ];
  }
}
