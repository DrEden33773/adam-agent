import { type ContextProfile, isContextProfileSupported } from "./context-profile.js";

export type UserModelPolicySnapshot = {
  readonly contextWindowTokens: number | null;
  readonly maximumOutputTokens: number | null;
  readonly automaticCompactionWindowTokens: number | null;
};

export type UserModelPolicyField = keyof UserModelPolicySnapshot;

export type UserModelPolicyResolver = {
  resolveContextProfile(profile: ContextProfile): Promise<ContextProfile>;
};

export function createUserModelPolicyResolver(options: {
  readonly load: () => Promise<UserModelPolicySnapshot>;
}): UserModelPolicyResolver {
  return {
    async resolveContextProfile(profile) {
      const policy = await options.load();
      const contextWindowTokens = Math.min(
        profile.contextWindowTokens,
        policy.contextWindowTokens ?? profile.contextWindowTokens,
      );
      const maximumOutputTokens = Math.min(
        profile.maximumOutputTokens,
        policy.maximumOutputTokens ?? profile.maximumOutputTokens,
        contextWindowTokens - 1,
      );
      const compactAtTokens = Math.min(
        profile.compactAtTokens,
        policy.automaticCompactionWindowTokens ?? profile.compactAtTokens,
        Math.floor(contextWindowTokens * 0.9),
      );
      const effective: ContextProfile = {
        ...profile,
        contextWindowTokens,
        maximumOutputTokens,
        compactAtTokens,
        ...(profile.compactionSummaryMaximumOutputTokens === undefined
          ? {}
          : {
              compactionSummaryMaximumOutputTokens: Math.min(
                profile.compactionSummaryMaximumOutputTokens,
                maximumOutputTokens,
              ),
            }),
      };
      if (!isContextProfileSupported(effective)) {
        throw new TypeError(
          "The configured model limits do not produce a supported context profile.",
        );
      }
      return effective;
    },
  };
}
