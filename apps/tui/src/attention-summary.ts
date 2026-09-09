import type { ManagedAttentionItem, ManagedWorkspaceSnapshot } from "@adam-agent/presentation";
import { visibleWidth } from "@earendil-works/pi-tui";
import { managedAttentionKey } from "./attention-center.js";
import { safeTerminalText } from "./safe-terminal-text.js";
import type { AdamTuiTheme } from "./theme.js";

export function uniqueAttention(items: readonly ManagedAttentionItem[]): ManagedAttentionItem[] {
  return [...new Map(items.map((item) => [managedAttentionKey(item), item])).values()];
}

export function blockingAttention(
  items: readonly ManagedAttentionItem[],
  snapshot: ManagedWorkspaceSnapshot | undefined,
  selectedThreadId?: string,
): readonly ManagedAttentionItem[] {
  const blocked = new Set<string>();
  for (const wait of snapshot?.waits ?? []) {
    const outstanding = wait.targets.filter(
      (target) =>
        !snapshot?.completions.some(
          (entry) => entry.threadId === target.threadId && entry.turnId === target.expectedTurnId,
        ),
    );
    if (wait.mode === "any" && outstanding.length !== wait.targets.length) continue;
    const requests = outstanding.map((target) =>
      items.filter(
        (item) => item.threadId === target.threadId && item.turnId === target.expectedTurnId,
      ),
    );
    if (wait.mode === "all" || (requests.length > 0 && requests.every((group) => group.length > 0)))
      for (const item of requests.flat()) blocked.add(managedAttentionKey(item));
  }
  return items.filter(
    (item) => item.threadId === selectedThreadId || blocked.has(managedAttentionKey(item)),
  );
}

export function attentionSummary(
  source: readonly ManagedAttentionItem[],
  width: number,
  keys: string,
  theme: AdamTuiTheme,
): string | undefined {
  const items = uniqueAttention(source);
  if (items.length === 0) return undefined;
  const count = `${theme.markdown.bold(theme.statusWarning(String(items.length)))}${theme.statusWarning(" pending")}`;
  const action = `${theme.keyword(keys)} ${theme.text("open")}`;
  const separator = theme.muted(" · ");
  const representative = items[0];
  const subject =
    representative === undefined
      ? ""
      : `${theme.reference(safeTerminalText(representative.handle))}: ${theme.text(representative.kind === "permission" ? "permission" : "reply")}`;
  const permissions = items.filter((item) => item.kind === "permission").length;
  const categories = theme.text(
    [
      ...(permissions > 0 ? [`${permissions} permission`] : []),
      ...(items.length > permissions ? [`${items.length - permissions} reply`] : []),
    ].join(" / "),
  );
  const candidates = [
    [count, categories, subject, action, theme.keyword("/agents attention")],
    [count, categories, subject, action],
    [count, subject, action],
    [count, action],
  ];
  return (
    candidates.map((parts) => parts.join(separator)).find((line) => visibleWidth(line) <= width) ??
    [count, action].join(separator)
  );
}
