export type ContextProfile = {
  readonly version: number;
  readonly contextWindowTokens: number;
  readonly maximumOutputTokens: number;
  readonly ordinaryOutputReserveTokens?: number | undefined;
  readonly compactionSummaryMaximumOutputTokens?: number | undefined;
  readonly compactAtTokens: number;
  readonly postCompactTargetTokens: number;
  readonly retainedTargetTokens: number;
  readonly estimatorVersion: 1;
};

export function resolveOrdinaryMaximumOutputTokens(
  profile: ContextProfile,
  estimatedInputTokens: number,
): number {
  if (profile.ordinaryOutputReserveTokens === undefined) {
    return profile.maximumOutputTokens;
  }
  return Math.min(
    profile.maximumOutputTokens,
    profile.contextWindowTokens - estimatedInputTokens - profile.ordinaryOutputReserveTokens,
  );
}

export function resolveCompactionSummaryMaximumOutputTokens(profile: ContextProfile): number {
  return profile.compactionSummaryMaximumOutputTokens ?? profile.maximumOutputTokens;
}

export function isContextProfileSupported(profile: ContextProfile): boolean {
  if (
    !Number.isSafeInteger(profile.version) ||
    !Number.isSafeInteger(profile.contextWindowTokens) ||
    !Number.isSafeInteger(profile.maximumOutputTokens) ||
    !Number.isSafeInteger(profile.compactAtTokens) ||
    !Number.isSafeInteger(profile.postCompactTargetTokens) ||
    !Number.isSafeInteger(profile.retainedTargetTokens) ||
    profile.contextWindowTokens <= 0 ||
    profile.maximumOutputTokens <= 0 ||
    profile.postCompactTargetTokens <= 0 ||
    profile.retainedTargetTokens < 0 ||
    profile.retainedTargetTokens > profile.postCompactTargetTokens ||
    profile.postCompactTargetTokens >= profile.compactAtTokens ||
    profile.compactAtTokens >= profile.contextWindowTokens ||
    profile.maximumOutputTokens >= profile.contextWindowTokens ||
    profile.estimatorVersion !== 1
  ) {
    return false;
  }
  if (profile.version === 1) {
    return (
      profile.ordinaryOutputReserveTokens === undefined &&
      profile.compactionSummaryMaximumOutputTokens === undefined
    );
  }
  if (profile.version !== 2) {
    return false;
  }
  return (
    Number.isSafeInteger(profile.ordinaryOutputReserveTokens) &&
    (profile.ordinaryOutputReserveTokens ?? -1) >= 0 &&
    Number.isSafeInteger(profile.compactionSummaryMaximumOutputTokens) &&
    (profile.compactionSummaryMaximumOutputTokens ?? 0) > 0 &&
    (profile.compactionSummaryMaximumOutputTokens ?? Number.POSITIVE_INFINITY) <=
      profile.maximumOutputTokens &&
    profile.compactAtTokens + (profile.ordinaryOutputReserveTokens ?? 0) <
      profile.contextWindowTokens
  );
}
