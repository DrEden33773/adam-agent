/** Explicit Owner input in an already selected managed-task follow-up composer. */
export function parseTaskBudgetFollowUp(text: string): {
  task: string;
  additionalBudgetTokens?: number;
} {
  if (!text.startsWith("/budget-add")) return { task: text };
  const match = /^\/budget-add\s+(\d+)\s+([\s\S]+)$/u.exec(text);
  const amount = Number(match?.[1]);
  if (
    match === null ||
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    match[2]?.trim().length === 0
  ) {
    throw new TypeError("Use /budget-add <positive tokens> <follow-up task>.");
  }
  return { task: match[2] ?? "", additionalBudgetTokens: amount };
}
