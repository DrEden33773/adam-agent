export type ContextProfile = {
  readonly version: number;
  readonly contextWindowTokens: number;
  readonly maximumOutputTokens: number;
  readonly compactAtTokens: number;
  readonly postCompactTargetTokens: number;
  readonly retainedTargetTokens: number;
  readonly estimatorVersion: 1;
};

export const sessionContextProfile = Symbol("adam-agent.session-context-profile");
