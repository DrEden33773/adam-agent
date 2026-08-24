import type { EditorTheme, MarkdownTheme } from "@earendil-works/pi-tui";

/**
 * Catppuccin Mocha semantic projection adapted from sherif-fanous/pi-catppuccin
 * commit cd09277df06621155d9c4c20e45309bce5341779 (MIT). See THIRD_PARTY_NOTICES.md.
 */

export type AdamSyntaxTheme = Readonly<
  Record<string, (text: string) => string> & {
    readonly default: (text: string) => string;
  }
>;

export type AdamTuiTheme = {
  readonly allow: (text: string) => string;
  readonly danger: (text: string) => string;
  readonly deny: (text: string) => string;
  readonly editor: EditorTheme;
  readonly inverseSelection: (text: string) => string;
  readonly keyword: (text: string) => string;
  readonly markdown: MarkdownTheme;
  readonly muted: (text: string) => string;
  readonly primary: (text: string) => string;
  readonly subject: (text: string) => string;
  readonly syntax: AdamSyntaxTheme;
  readonly lineNumber: (text: string) => string;
  readonly diffAddition: (text: string) => string;
  readonly diffDeletion: (text: string) => string;
  readonly toolBackground: (text: string) => string;
  readonly toolOutput: (text: string) => string;
  readonly toolTitle: (text: string) => string;
  readonly userBackground: (text: string) => string;
  readonly userText: (text: string) => string;
  readonly userMarker: string;
};

export function createAdamTuiTheme(noColor = noColorRequested()): AdamTuiTheme {
  const color = (red: number, green: number, blue: number) =>
    noColor ? identity : (text: string) => `\u001b[38;2;${red};${green};${blue}m${text}\u001b[39m`;
  const background = (red: number, green: number, blue: number) =>
    noColor ? identity : (text: string) => `\u001b[48;2;${red};${green};${blue}m${text}\u001b[49m`;
  const bold = (style: (text: string) => string) => (text: string) =>
    noColor ? text : `\u001b[1m${style(text)}\u001b[22m`;
  const boldOnly = (text: string) => (noColor ? text : `\u001b[1m${text}\u001b[22m`);
  const italic = (text: string) => (noColor ? text : `\u001b[3m${text}\u001b[23m`);
  const strikethrough = (text: string) => (noColor ? text : `\u001b[9m${text}\u001b[29m`);
  const underline = (text: string) => (noColor ? text : `\u001b[4m${text}\u001b[24m`);
  const text = color(205, 214, 244);
  const muted = color(166, 173, 200);
  const mauve = color(203, 166, 247);
  const red = color(243, 139, 168);
  const green = color(166, 227, 161);
  const blue = color(137, 180, 250);
  const pink = color(245, 194, 231);
  const teal = color(148, 226, 213);
  const peach = color(250, 179, 135);
  const yellow = color(249, 226, 175);
  const lavender = color(180, 190, 254);
  const overlay = color(108, 112, 134);
  const subtext = color(186, 194, 222);
  const crust = color(17, 17, 27);

  return {
    primary: text,
    muted,
    keyword: bold(mauve),
    subject: blue,
    lineNumber: overlay,
    diffAddition: green,
    diffDeletion: red,
    syntax: {
      default: subtext,
      comment: overlay,
      quote: overlay,
      keyword: mauve,
      literal: mauve,
      "selector-tag": mauve,
      string: green,
      regexp: green,
      attribute: green,
      number: peach,
      bullet: peach,
      title: blue,
      section: blue,
      function: blue,
      name: blue,
      type: yellow,
      class: yellow,
      params: lavender,
      variable: pink,
      "template-variable": pink,
      meta: teal,
      doctag: teal,
      addition: green,
      deletion: red,
    },
    danger: red,
    allow: green,
    deny: red,
    inverseSelection: (value) => background(205, 214, 244)(crust(value)),
    userText: text,
    userBackground: background(49, 50, 68),
    userMarker: noColor ? "› " : "",
    toolBackground: background(24, 24, 37),
    toolTitle: bold(mauve),
    toolOutput: subtext,
    editor: {
      borderColor: overlay,
      selectList: {
        selectedPrefix: mauve,
        selectedText: text,
        description: muted,
        scrollInfo: muted,
        noMatch: muted,
      },
    },
    markdown: {
      heading: bold(red),
      link: blue,
      linkUrl: blue,
      code: green,
      codeBlock: green,
      codeBlockBorder: muted,
      quote: text,
      quoteBorder: teal,
      hr: pink,
      listBullet: mauve,
      bold: boldOnly,
      italic,
      strikethrough,
      underline,
    },
  };
}

function identity(text: string): string {
  return text;
}

function noColorRequested(): boolean {
  const { NO_COLOR: noColor } = process.env;
  return noColor !== undefined;
}
