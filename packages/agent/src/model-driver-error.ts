export const modelDriverErrorCategories = [
  "authentication",
  "authorization",
  "billing",
  "rate_limit",
  "invalid_request",
  "provider",
  "transport",
  "protocol_incompatibility",
  "timeout",
  "aborted",
  "unknown",
] as const;

export type ModelDriverErrorCategory = (typeof modelDriverErrorCategories)[number];

export class ModelDriverError extends Error {
  readonly category: ModelDriverErrorCategory;
  readonly status: number | undefined;
  readonly providerCode: string | undefined;
  readonly requestId: string | undefined;
  readonly responseSummary: string | undefined;

  constructor(
    category: ModelDriverErrorCategory,
    message: string,
    options: {
      readonly cause: unknown;
      readonly status?: number | undefined;
      readonly providerCode?: string | undefined;
      readonly requestId?: string | undefined;
      readonly responseSummary?: string | undefined;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "ModelDriverError";
    this.category = category;
    this.status = options.status;
    this.providerCode = options.providerCode;
    this.requestId = options.requestId;
    this.responseSummary = options.responseSummary;
  }
}
