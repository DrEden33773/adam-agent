export const agentSkillsEvalCorpusV1 = {
  version: "adam-agent-skills-eval-v1",
  skills: [
    {
      name: "vitest-failure-triage",
      description:
        "Diagnoses Vitest failure output and separates assertion defects from environment or setup failures. Use when a user asks to triage a failing Vitest run or pasted test output.",
      body: `# Vitest failure triage

Respond under exactly these headings: Classification, Evidence, Next check.

Classify the smallest failing layer before proposing a code change. If almost all tests pass and a special-file operation fails with EPERM, identify an environment restriction before blaming the product. Preserve the safety assertion and recommend rerunning the unchanged case in an environment that supports the required operating-system primitive.`,
    },
    {
      name: "typescript-api-compatibility",
      description:
        "Reviews a TypeScript public API change for source compatibility. Use when a user asks whether exported TypeScript types or signatures introduce a breaking change.",
      body: `# TypeScript API compatibility review

请按 Compatibility verdict、Evidence、Minimal change 三个标题回答。

逐项区分新增可选字段与删除既有导出联合类型成员。新增可选字段通常保持源码兼容；删除调用方可能使用的公开联合成员属于破坏性变更。只建议满足兼容性所需的最小改动。`,
    },
    {
      name: "migration-rollout-checklist",
      description:
        "Builds a migration rollout checklist when a request includes both a persisted format version change and an explicit rollback requirement.",
      body: `# Migration rollout checklist

Produce a phased checklist covering preflight, forward migration, verification, rollback trigger, rollback execution, and post-rollback verification. Never claim rollback safety unless old readers can consume the retained data or a separately verified reverse migration exists. Include one explicit no-data-loss check.`,
    },
  ],
  cases: [
    {
      id: "should-activate-vitest-en",
      kind: "should_activate",
      prompt:
        "Diagnose this Vitest result and recommend the next action: 564 tests passed; only the FIFO case failed with spawnSync mkfifo EPERM and the Unix-socket case failed with listen EPERM inside a restricted runner.",
      expectedSkill: "vitest-failure-triage",
      qualitySignals: ["environment restriction", "preserve safety test", "rerun unchanged"],
    },
    {
      id: "should-activate-api-zh",
      kind: "should_activate",
      prompt:
        "请审查这个 TypeScript 公共 API 变更是否破坏兼容性：给公开 options 新增一个可选字段，同时从已导出的联合类型中删除一个旧成员。请给出最小修复建议。",
      expectedSkill: "typescript-api-compatibility",
      qualitySignals: [
        "breaking union removal",
        "optional field compatible",
        "minimal restoration",
      ],
    },
    {
      id: "context-dependent-migration-en",
      kind: "context_dependent",
      prompt:
        "We are moving a persisted configuration from version 1 to version 2. Prepare a staged rollout that can return to version 1 without data loss if verification fails.",
      expectedSkill: "migration-rollout-checklist",
      qualitySignals: [
        "rollback trigger",
        "old-reader or reverse-migration proof",
        "no-data-loss check",
      ],
    },
    {
      id: "explicit-migration-zh",
      kind: "explicit",
      prompt: "把这条简短发布说明整理成安全执行计划：配置格式升级，验证异常时回退。",
      expectedSkill: "migration-rollout-checklist",
      qualitySignals: ["phased checklist", "rollback verification"],
    },
    {
      id: "negative-arithmetic-en",
      kind: "negative",
      prompt: "Explain in two sentences why two plus two equals four.",
    },
    {
      id: "negative-poem-zh",
      kind: "negative",
      prompt: "写一首关于晚风的四行短诗，不要讨论软件工程。",
    },
  ],
} as const;

export type AgentSkillsEvalCaseV1 = (typeof agentSkillsEvalCorpusV1.cases)[number];
