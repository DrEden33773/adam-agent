import type { Component } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { TranscriptViewport } from "./transcript-viewport.js";

class Lines implements Component {
  renders = 0;
  constructor(public lines: string[]) {}
  render(width: number): string[] {
    this.renders += 1;
    return this.lines.flatMap((line) => {
      const result: string[] = [];
      for (let offset = 0; offset < line.length; offset += width)
        result.push(line.slice(offset, offset + width));
      return result.length === 0 ? [""] : result;
    });
  }
  invalidate(): void {}
}

function layout(viewport: TranscriptViewport, width = 20, height = 10): string[] {
  const contentWidth = viewport.scrollView.getContentWidth(width);
  const lines = viewport.document.render(contentWidth);
  viewport.scrollView.updateLayout(lines.length, height, () => {});
  return lines.slice(viewport.scrollView.scrollTop, viewport.scrollView.scrollTop + height);
}

function add(viewport: TranscriptViewport, id: string, lines: string[]): Lines {
  const component = new Lines(lines);
  viewport.document.addChild(component);
  viewport.setAnchor(id, component);
  viewport.setSemanticAnchor(id, component);
  return component;
}

test.each([50, 100, 200, 400])("anchor selection reuses the %i-item rendered layout", (count) => {
  const viewport = new TranscriptViewport();
  const components = Array.from({ length: count }, (_, index) =>
    add(viewport, `item-${index}`, [`line-${index}`]),
  );
  layout(viewport);
  viewport.scrollView.scrollTo(0);
  const before = components.reduce((total, component) => total + component.renders, 0);
  expect(
    viewport.selectVisibleAnchor(
      components.map((_, index) => `item-${index}`),
      20,
    ),
  ).toBe("item-4");
  expect(components.reduce((total, component) => total + component.renders, 0) - before).toBe(0);
});

test("manual reading survives streaming, card collapse, older pages and width changes", () => {
  const viewport = new TranscriptViewport();
  const render = (prefix: string[], suffix: string[]) => {
    viewport.clear();
    add(viewport, "older", prefix);
    add(viewport, "reading", ["abcdefghijklmnopqrst", "second reading line", "third reading line"]);
    add(viewport, "streaming", suffix);
  };
  const tail = Array.from({ length: 15 }, (_, i) => `tail-${i}`);
  render(["old-1", "old-2", "tool details", "card running", "card details"], tail);
  layout(viewport);
  viewport.scrollView.scrollTo(6);
  expect(layout(viewport)[0]).toBe("second reading line");

  render(
    ["old-1", "old-2", "tool details", "card running", "card details"],
    [...tail, "new streamed line"],
  );
  expect(layout(viewport)[0]).toBe("second reading line");
  expect(viewport.scrollView.scrollTop).toBe(6);
  render(["old-1", "old-2", "card running", "card details"], tail);
  expect(layout(viewport)[0]).toBe("second reading line");
  expect(viewport.scrollView.scrollTop).toBe(5);
  render(["old-1", "old-2", "card completed"], tail);
  expect(layout(viewport)[0]).toBe("second reading line");
  expect(viewport.scrollView.scrollTop).toBe(4);
  render(["older-a", "older-b", "older-c", "old-1", "old-2", "card completed"], tail);
  expect(layout(viewport)[0]).toBe("second reading line");
  expect(viewport.scrollView.scrollTop).toBe(7);
  expect(viewport.scrollView.isFollowingEnd).toBe(false);
  expect(layout(viewport, 10)[0]).toBe("klmnopqrst");
  expect(viewport.scrollView.isFollowingEnd).toBe(false);
});

test("shortened and deleted reading anchors clamp to available content and can be captured again", () => {
  const viewport = new TranscriptViewport();
  const rebuild = (reading: string[] | null) => {
    viewport.clear();
    add(viewport, "prefix", ["prefix"]);
    if (reading !== null) add(viewport, "reading", reading);
    add(viewport, "tail", ["tail-1", "tail-2", "tail-3", "tail-4", "tail-5"]);
  };
  rebuild(["read-1", "read-2", "read-3", "read-4"]);
  layout(viewport, 20, 3);
  viewport.scrollView.scrollTo(4);
  rebuild(["short"]);
  expect(layout(viewport, 20, 3)[0]).toBe("short");
  expect(viewport.scrollView.scrollTop).toBe(1);
  rebuild(null);
  expect(layout(viewport, 20, 3)[0]).toBe("tail-1");
  viewport.clear();
  add(viewport, "prefix", ["older", "prefix"]);
  add(viewport, "tail", ["tail-1", "tail-2", "tail-3", "tail-4", "tail-5"]);
  expect(layout(viewport, 20, 3)[0]).toBe("tail-1");
  expect(viewport.scrollView.scrollTop).toBe(2);
});

test("Todo or Widget height changes do not turn manual reading into follow-tail", () => {
  const viewport = new TranscriptViewport();
  const populate = (count: number) => {
    viewport.clear();
    for (let index = 0; index < count; index += 1)
      add(viewport, `item-${index}`, [`line-${index}`]);
  };
  populate(20);
  layout(viewport, 20, 5);
  viewport.scrollView.scrollTo(10);
  expect(layout(viewport, 20, 5)[0]).toBe("line-10");
  expect(viewport.scrollView.isFollowingEnd).toBe(false);

  // Todo/Widget sibling regions release five rows to the transcript. The user's
  // current line now happens to be the bottom position, without a scroll action.
  expect(layout(viewport, 20, 10)[0]).toBe("line-10");
  expect(viewport.scrollView.isFollowingEnd).toBe(false);
  populate(21);
  expect(layout(viewport, 20, 10)[0]).toBe("line-10");
  expect(viewport.scrollView.isFollowingEnd).toBe(false);
  expect(layout(viewport, 20, 5)[0]).toBe("line-10");

  viewport.scrollView.scrollBy(100);
  expect(viewport.scrollView.isFollowingEnd).toBe(true);
  populate(22);
  expect(layout(viewport, 20, 5)[0]).toBe("line-17");
});
