import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseDocument, stringify } from "yaml";
import { z } from "zod";

export const agentRoleIdSchema = z
  .string()
  .regex(/^(builtin:(explore|research)|(project|user):[^\s\p{Cc}:]+)$/u)
  .max(512);
const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((name) => !/[\p{Cc}:]/u.test(name));
const namesSchema = z.union([z.array(z.string().min(1)).max(32), z.string()]).transform((value) =>
  typeof value === "string"
    ? value
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
    : value,
);
const limitsSchema = z.strictObject({
  maxTokens: z.number().int().positive().optional(),
  maxTurns: z.number().int().min(1).max(128).optional(),
});
export const agentRoleDefinitionSchema = z.strictObject({
  qualifiedId: agentRoleIdSchema,
  name: nameSchema,
  displayName: nameSchema.optional(),
  description: z.string().min(1).max(1024),
  base: z.enum(["explore", "research"]),
  tools: z.array(z.string()).max(32).readonly(),
  web: z.boolean(),
  source: z
    .strictObject({ kind: z.enum(["builtin", "project", "user"]), path: z.string().optional() })
    .optional(),
  baseVersion: z.literal("non-mutating-role.v1").optional(),
  instructions: z.string().max(65536).optional(),
  color: z.string().min(1).max(32).optional(),
  model: z.string().min(1).max(256).optional(),
  thinking: z.string().min(1).max(128).optional(),
  skills: z.union([z.boolean(), z.array(z.string()).max(128)]).optional(),
  contextMode: z.enum(["task", "current_request"]).optional(),
  limits: limitsSchema.optional(),
  overrides: agentRoleIdSchema.optional(),
  definitionDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
});
export type AgentRoleDefinition = z.infer<typeof agentRoleDefinitionSchema>;
export type AgentRoleCatalog = {
  readonly roles: readonly AgentRoleDefinition[];
  readonly definitions?: readonly AgentRoleDefinition[];
  readonly disabledIds?: readonly string[];
  readonly diagnostics: readonly { readonly source: string; readonly message: string }[];
};
const withDigest = (role: Omit<AgentRoleDefinition, "definitionDigest">): AgentRoleDefinition => ({
  ...role,
  definitionDigest: `sha256:${createHash("sha256").update(JSON.stringify(role)).digest("hex")}`,
});
const explore = {
  qualifiedId: "builtin:explore",
  name: "Explore",
  description: "Explore repository evidence with read tools and Skills.",
  base: "explore",
  tools: [
    "read_file",
    "search_repository",
    "read_input_resource",
    "activate_skill",
    "read_skill_resource",
    "report_to_parent",
    "request_parent_input",
  ],
  web: false,
  source: { kind: "builtin" },
  baseVersion: "non-mutating-role.v1",
  skills: true,
  contextMode: "current_request",
} as const;
export const builtinAgentRoles: readonly AgentRoleDefinition[] = [
  withDigest(explore),
  withDigest({
    ...explore,
    qualifiedId: "builtin:research",
    name: "Research",
    description: "Research evidence with Skills and permitted Web tools.",
    base: "research",
    web: true,
    tools: [...explore.tools, "web_fetch", "web_search", "web_open", "web_find"],
  }),
];
const frontmatterSchema = z.strictObject({
  name: nameSchema,
  display_name: nameSchema.optional(),
  description: z.string().trim().min(1).max(1024),
  color: z.string().min(1).max(32).optional(),
  base: z.enum(["explore", "research"]),
  overrides: agentRoleIdSchema.optional(),
  model: z.string().min(1).max(256).optional(),
  thinking: z.string().min(1).max(128).optional(),
  tools: namesSchema.optional(),
  skills: z.union([z.boolean(), namesSchema]).optional(),
  web: z.boolean().optional(),
  context_mode: z.enum(["task", "current_request"]).optional(),
  limits: limitsSchema.optional(),
});

export type RoleDefinitionInput = z.input<typeof frontmatterSchema>;
export type RoleCatalogMutation =
  | {
      readonly action: "create";
      readonly source: "project" | "user";
      readonly fields: RoleDefinitionInput;
      readonly instructions: string;
      readonly original?: { readonly qualifiedId: string; readonly definitionDigest: string };
    }
  | {
      readonly action: "toggle";
      readonly qualifiedId: string;
      readonly definitionDigest: string;
      readonly enabled: boolean;
    };

function parseDefinition(
  text: string,
  kind: "project" | "user",
  path: string,
): AgentRoleDefinition {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(text);
  if (match === null) throw new Error("Add YAML frontmatter with name, description, and base.");
  const document = parseDocument(match[1] ?? "", { uniqueKeys: true });
  if (document.errors.length > 0) throw new Error(document.errors[0]?.message);
  const fields = frontmatterSchema.parse(document.toJS({ maxAliasCount: 0 }));
  const base = builtinAgentRoles.find((role) => role.base === fields.base);
  if (base === undefined) throw new Error("Select Explore or Research base.");
  const declaredTools = fields.tools ?? base.tools;
  const tools = declaredTools.filter(
    (tool) =>
      (fields.skills !== false || (tool !== "activate_skill" && tool !== "read_skill_resource")) &&
      (fields.web !== false || !["web_fetch", "web_search", "web_open", "web_find"].includes(tool)),
  );
  if (declaredTools.some((tool) => !base.tools.includes(tool)))
    throw new Error("Tools may only narrow the declared base; remove unsupported tools.");
  if (fields.web === true && !base.web) throw new Error("Web requires Research base.");
  if (fields.overrides !== undefined && fields.overrides !== base.qualifiedId)
    throw new Error("overrides must name the exact built-in matching this base.");
  const collision = builtinAgentRoles.find(
    (role) => role.name.toLocaleLowerCase() === fields.name.toLocaleLowerCase(),
  );
  if (collision !== undefined && fields.overrides !== collision.qualifiedId)
    throw new Error(`Built-in name conflict; set overrides: ${collision.qualifiedId} explicitly.`);
  const role = withDigest({
    qualifiedId: `${kind}:${encodeURIComponent(fields.name)}`,
    name: fields.name,
    description: fields.description,
    base: fields.base,
    tools,
    web: fields.web ?? base.web,
    source: { kind, path },
    baseVersion: "non-mutating-role.v1",
    instructions: match[2]?.trim() ?? "",
    skills: fields.skills ?? true,
    contextMode: fields.context_mode ?? "current_request",
    ...(fields.display_name === undefined ? {} : { displayName: fields.display_name }),
    ...Object.fromEntries(
      ["color", "overrides", "model", "thinking", "limits"].flatMap((key) => {
        const value = Reflect.get(fields, key);
        return value === undefined ? [] : [[key, value]];
      }),
    ),
  });
  return agentRoleDefinitionSchema.parse(role);
}

/** The lifecycle owns this catalog; reload changes future admissions only. */
export function createAgentRoleCatalog(options: {
  readonly workspaceRoot: string;
  readonly userDirectory: string;
  readonly projectTrusted: () => Promise<boolean>;
}) {
  let snapshot: AgentRoleCatalog | undefined;
  const reload = async (): Promise<AgentRoleCatalog> => {
    const roles: AgentRoleDefinition[] = [...builtinAgentRoles];
    const diagnostics: { source: string; message: string }[] = [];
    const disabledIds: string[] = [];
    const roots: { kind: "project" | "user"; path: string }[] = [
      { kind: "user", path: options.userDirectory },
    ];
    if (await options.projectTrusted())
      roots.push({ kind: "project", path: join(options.workspaceRoot, ".agents", "agents") });
    for (const root of roots) {
      try {
        const canonical = await realpath(root.path);
        if (
          (await lstat(root.path)).isSymbolicLink() ||
          (root.kind === "project" &&
            relative(await realpath(options.workspaceRoot), canonical)
              .split(/[\\/]/u)
              .includes(".."))
        )
          throw new Error("Role directory must remain inside its trusted source.");
        const names = await readdir(root.path);
        if (root.kind === "user") {
          for (const marker of names.filter((name) => name.startsWith("disabled-"))) {
            try {
              const id = agentRoleIdSchema.parse(decodeURIComponent(marker.slice(9)));
              if (!(await lstat(join(root.path, marker))).isFile())
                throw new Error("Disabled role marker must be a regular file.");
              disabledIds.push(id);
            } catch (error) {
              diagnostics.push({
                source: join(root.path, marker),
                message: error instanceof Error ? error.message : "Invalid disabled role marker.",
              });
            }
          }
        }
        const files = names.filter((file) => file.endsWith(".md")).sort();
        if (files.length > 128) throw new Error("Keep at most 128 role definitions per source.");
        for (const file of files) {
          const path = join(root.path, file);
          try {
            const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
            let text: string;
            try {
              const stat = await handle.stat();
              if (!stat.isFile() || stat.size > 65536)
                throw new Error(
                  "Role definition must be a regular Markdown file of at most 64 KiB.",
                );
              text = await handle.readFile("utf8");
            } finally {
              await handle.close();
            }
            roles.push(parseDefinition(text, root.kind, path));
          } catch (error) {
            diagnostics.push({
              source: path,
              message: error instanceof Error ? error.message : "Invalid role definition.",
            });
          }
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
          diagnostics.push({
            source: root.path,
            message: error instanceof Error ? error.message : "Role directory unavailable.",
          });
      }
    }
    const collisions = new Set(
      roles
        .filter((role, index) =>
          roles.some(
            (other, otherIndex) =>
              index !== otherIndex &&
              (other.qualifiedId === role.qualifiedId ||
                (role.overrides !== undefined && role.overrides === other.overrides)),
          ),
        )
        .map((role) => role.qualifiedId),
    );
    for (const role of roles.filter((role) => collisions.has(role.qualifiedId)))
      diagnostics.push({
        source: role.source?.path ?? role.qualifiedId,
        message: "Duplicate role identity or override; keep one definition.",
      });
    const valid = roles.filter((role) => !collisions.has(role.qualifiedId));
    snapshot = {
      definitions: valid,
      disabledIds,
      roles: valid.filter(
        (role) =>
          !disabledIds.includes(role.qualifiedId) &&
          !valid.some(
            (other) =>
              !disabledIds.includes(other.qualifiedId) && other.overrides === role.qualifiedId,
          ),
      ),
      diagnostics,
    };
    return snapshot;
  };
  const inDirectory = async <T>(
    kind: "project" | "user",
    action: (root: string, sync: () => Promise<void>) => Promise<T>,
  ): Promise<T> => {
    if (kind === "project" && !(await options.projectTrusted()))
      throw new Error("Trust the project before changing its role definitions.");
    const root =
      kind === "project" ? join(options.workspaceRoot, ".agents", "agents") : options.userDirectory;
    // Pin each project component before creating the next, so .agents cannot redirect writes.
    const parent = kind === "project" ? options.workspaceRoot : join(root, "..");
    if (kind === "user") await mkdir(parent, { recursive: true, mode: 0o700 });
    let directory = await open(
      parent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const components =
        kind === "project" ? [".agents", "agents"] : [root.split("/").at(-1) ?? "agents"];
      for (const component of components) {
        const next = join(`/proc/self/fd/${directory.fd}`, component);
        await mkdir(next, { mode: 0o700 }).catch((error) => {
          if (error.code !== "EEXIST") throw error;
        });
        const opened = await open(
          next,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        await directory.close();
        directory = opened;
      }
      return await action(`/proc/self/fd/${directory.fd}`, () => directory.sync());
    } finally {
      await directory.close();
    }
  };
  const atomicWrite = async (
    kind: "project" | "user",
    name: string,
    content: string,
    replace = false,
  ) => {
    if (name.includes("/") || name.includes("\\") || Buffer.byteLength(content, "utf8") > 65536)
      throw new Error("Invalid role file.");
    await inDirectory(kind, async (root, sync) => {
      const temporary = join(root, `.role-${randomUUID()}.tmp`);
      try {
        const file = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await file.writeFile(content, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        if (replace) await rename(temporary, join(root, name));
        else await link(temporary, join(root, name));
        await sync();
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    });
  };
  return {
    async sources() {
      return [
        {
          kind: "project" as const,
          path: join(options.workspaceRoot, ".agents", "agents"),
          writable: await options.projectTrusted(),
        },
        { kind: "user" as const, path: options.userDirectory, writable: true },
      ];
    },
    async inspect(): Promise<AgentRoleCatalog> {
      const current = snapshot ?? (await reload());
      if (await options.projectTrusted()) return current;
      const definitions = (current.definitions ?? current.roles).filter(
        (role) => role.source?.kind !== "project",
      );
      const disabledIds = current.disabledIds ?? [];
      return {
        definitions,
        disabledIds,
        roles: definitions.filter(
          (role) =>
            !disabledIds.includes(role.qualifiedId) &&
            !definitions.some(
              (other) =>
                !disabledIds.includes(other.qualifiedId) && other.overrides === role.qualifiedId,
            ),
        ),
        diagnostics: current.diagnostics,
      };
    },
    reload,
    async mutate(input: RoleCatalogMutation): Promise<AgentRoleCatalog> {
      const current = await reload();
      const definitions = current.definitions ?? current.roles;
      if (input.action === "toggle") {
        const role = definitions.find(
          (role) =>
            role.qualifiedId === input.qualifiedId &&
            role.definitionDigest === input.definitionDigest,
        );
        if (role === undefined)
          throw new Error("The selected role changed; reload and select it again.");
        const marker = `disabled-${encodeURIComponent(role.qualifiedId)}`;
        if (input.enabled)
          await inDirectory("user", async (root, sync) => {
            await unlink(join(root, marker));
            await sync();
          });
        else await atomicWrite("user", marker, "disabled\n");
      } else {
        const fields = frontmatterSchema.parse(input.fields);
        const original =
          input.original === undefined
            ? undefined
            : definitions.find(
                (role) =>
                  role.qualifiedId === input.original?.qualifiedId &&
                  role.definitionDigest === input.original.definitionDigest,
              );
        if (input.original !== undefined && original === undefined)
          throw new Error("The original role changed; reload first.");
        const root =
          input.source === "project"
            ? join(options.workspaceRoot, ".agents", "agents")
            : options.userDirectory;
        const name = `${encodeURIComponent(fields.name)}.md`;
        const content = `---\n${stringify(fields)}---\n${input.instructions}\n`;
        const role = parseDefinition(content, input.source, join(root, name));
        if (
          definitions.some(
            (other) =>
              other.qualifiedId === role.qualifiedId ||
              (role.overrides !== undefined && role.overrides === other.overrides),
          )
        )
          throw new Error(
            "This role identity or override already exists; choose another name or source.",
          );
        await atomicWrite(input.source, name, content);
      }
      return reload();
    },
    async configureTarget(input: {
      readonly qualifiedId: string;
      readonly definitionDigest: string;
      readonly model: string | null;
    }): Promise<AgentRoleDefinition> {
      const current = await reload();
      const role = current.roles.find(
        (entry) =>
          entry.qualifiedId === input.qualifiedId &&
          entry.definitionDigest === input.definitionDigest,
      );
      if (role?.source?.path === undefined || role.source.kind === "builtin")
        throw new Error("Select an unchanged custom role definition.");
      if (role.source.kind === "project" && !(await options.projectTrusted()))
        throw new Error("Trust the project before changing its role definition.");
      const root =
        role.source.kind === "project"
          ? join(options.workspaceRoot, ".agents", "agents")
          : options.userDirectory;
      const fileName = role.source.path.slice(root.length + 1);
      const file = await open(role.source.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let text: string;
      try {
        text = await file.readFile("utf8");
      } finally {
        await file.close();
      }
      if (
        parseDefinition(text, role.source.kind, role.source.path).definitionDigest !==
        input.definitionDigest
      )
        throw new Error("The role definition changed; reload first.");
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(text);
      if (match === null) throw new Error("The role definition changed; reload first.");
      const document = parseDocument(match[1] ?? "", { uniqueKeys: true });
      if (input.model === null) document.delete("model");
      else document.set("model", input.model);
      document.delete("thinking");
      frontmatterSchema.parse(document.toJS({ maxAliasCount: 0 }));
      await atomicWrite(
        role.source.kind,
        fileName,
        `---\n${document.toString()}---\n${match[2] ?? ""}`,
        true,
      );
      const updated = (await reload()).roles.find(
        (entry) => entry.qualifiedId === input.qualifiedId,
      );
      if (updated === undefined)
        throw new Error("The updated role is unavailable; inspect diagnostics.");
      return updated;
    },
  };
}
