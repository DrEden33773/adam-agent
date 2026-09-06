import type { AgentRoleMutation, AgentTypesDisplay } from "@adam-agent/presentation";
import {
  type AgentRoleCatalog,
  type AgentRoleDefinition,
  builtinAgentRoles,
  type createAgentRoleCatalog,
} from "./role-catalog.js";

export type AgentRoleAdministration = {
  inspectAgentTypes(): Promise<AgentTypesDisplay>;
  mutateAgentTypes(input: AgentRoleMutation): Promise<void>;

  inspectRoleTarget(qualifiedId: string): Promise<
    | { readonly status: "available" }
    | {
        readonly status: "unavailable";
        readonly message: string;
        readonly targets: readonly { readonly targetId: string; readonly label: string }[];
      }
  >;
  configureRoleTarget(input: {
    readonly qualifiedId: string;
    readonly definitionDigest: string;
    readonly model: string | null;
  }): Promise<AgentRoleDefinition>;
  inspectRoles(options?: { readonly reload?: boolean }): Promise<AgentRoleCatalog>;
};

export function createAgentRoleAdministration(options: {
  readonly roleCatalog?: ReturnType<typeof createAgentRoleCatalog>;
  readonly roleTargets?: () => Promise<AgentTypesDisplay["targets"]>;
  readonly inspectTarget?: (role: AgentRoleDefinition) => Promise<unknown>;
  readonly inheritedTargetId: string;
  readonly authorize: <T>(operation: () => Promise<T>) => Promise<T>;
}): AgentRoleAdministration {
  const control: AgentRoleAdministration = {
    async inspectAgentTypes() {
      const catalog = await control.inspectRoles();
      return {
        sources: (await options.roleCatalog?.sources()) ?? [],
        definitions: (catalog.definitions ?? catalog.roles).map((role) => ({
          ...role,
          enabled: !catalog.disabledIds?.includes(role.qualifiedId),
          available: catalog.roles.some((entry) => entry.qualifiedId === role.qualifiedId),
        })),
        diagnostics: catalog.diagnostics,
        targets: (await options.roleTargets?.()) ?? [],
      };
    },
    async mutateAgentTypes(input) {
      await options.authorize(async () => {
        if (options.roleCatalog === undefined)
          throw new Error("Role configuration is unavailable.");
        if (
          input.action === "create" &&
          input.fields.model !== undefined &&
          !(await options.roleTargets?.())?.some((target) => target.targetId === input.fields.model)
        )
          throw new Error("Select an available certified target.");
        if (input.action === "create" && input.fields.thinking !== undefined) {
          const target = (await options.roleTargets?.())?.find(
            (target) => target.targetId === (input.fields.model ?? options.inheritedTargetId),
          );
          if (!target?.thinkingLevels?.some((level) => level.id === input.fields.thinking))
            throw new Error("Select thinking supported by this certified target.");
        }
        await options.roleCatalog.mutate(input);
      });
    },
    async inspectRoleTarget(qualifiedId) {
      const role = (await control.inspectRoles()).roles.find(
        (entry) => entry.qualifiedId === qualifiedId,
      );
      try {
        if (role === undefined) throw new Error("Role unavailable.");
        await options.inspectTarget?.(role);
        return { status: "available" };
      } catch (error) {
        return {
          status: "unavailable",
          message: error instanceof Error ? error.message : "Role target unavailable.",
          targets: (await options.roleTargets?.()) ?? [],
        };
      }
    },
    async configureRoleTarget(input) {
      return options.authorize(async () => {
        if (options.roleCatalog === undefined)
          throw new Error("Role configuration is unavailable.");
        if (
          input.model !== null &&
          !(await options.roleTargets?.())?.some((target) => target.targetId === input.model)
        )
          throw new Error("Select an available certified target.");
        return options.roleCatalog.configureTarget(input);
      });
    },
    async inspectRoles(input) {
      return (
        (input?.reload ? options.roleCatalog?.reload() : options.roleCatalog?.inspect()) ?? {
          roles: builtinAgentRoles,
          diagnostics: [],
        }
      );
    },
  };
  return control;
}
