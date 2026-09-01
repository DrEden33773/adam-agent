import type { DefaultTreeAdapterMap } from "parse5";
import { parse } from "parse5";

type HtmlNode = DefaultTreeAdapterMap["node"];

const excludedElements = new Set(["script", "style", "noscript", "template", "svg"]);
const blockElements = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);

export function extractWebText(
  mediaType: string,
  body: Uint8Array,
): { readonly mediaType: "text/plain"; readonly text: string } | undefined {
  const essence = mediaType.toLowerCase().split(";", 1)[0]?.trim();
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return undefined;
  }
  if (essence === "text/plain" || essence === "application/json") {
    return { mediaType: "text/plain", text: source };
  }
  if (essence !== "text/html") {
    return undefined;
  }
  const fragments: string[] = [];
  visitHtmlNode(parse(source), fragments);
  const text = fragments
    .join("")
    .split("\n")
    .map((line) => line.replace(/[\t\f\r ]+/gu, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
  return { mediaType: "text/plain", text };
}

function visitHtmlNode(node: HtmlNode, fragments: string[]): void {
  if (node.nodeName === "#text" && "value" in node) {
    fragments.push(node.value);
    return;
  }
  const tagName = "tagName" in node ? node.tagName : undefined;
  if (tagName !== undefined && excludedElements.has(tagName)) {
    return;
  }
  const block = tagName !== undefined && blockElements.has(tagName);
  if (block) {
    fragments.push("\n");
  }
  if ("childNodes" in node) {
    for (const child of node.childNodes) {
      visitHtmlNode(child, fragments);
    }
  }
  if (block) {
    fragments.push("\n");
  } else if (tagName !== undefined) {
    fragments.push(" ");
  }
}
