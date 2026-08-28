import {
  type Component,
  Container,
  ScrollView,
  type ScrollViewScrollToOptions,
} from "@earendil-works/pi-tui";

type AnchorMetric = number | ((width: number) => number);

type Anchor = {
  readonly component: Component;
  readonly line: AnchorMetric;
  readonly height?: AnchorMetric;
};

type ViewportPosition = {
  readonly anchorId: string;
  readonly lineOffset: number;
  readonly screenRow: number;
};

class AnchoredScrollView extends ScrollView {
  readonly #captureBeforeWidthChange: () => void;
  readonly #desiredScrollTop: () => number | null;
  readonly #releasePosition: () => void;
  #contentWidth = 1;
  #onScrollDirection: ((direction: "up" | "down") => void) | undefined;

  constructor(
    component: Component,
    desiredScrollTop: () => number | null,
    releasePosition: () => void,
    captureBeforeWidthChange: () => void,
  ) {
    super(component, {
      follow: "end",
      overscroll: "chain",
      primary: true,
      scrollbar: "auto",
    });
    this.#desiredScrollTop = desiredScrollTop;
    this.#releasePosition = releasePosition;
    this.#captureBeforeWidthChange = captureBeforeWidthChange;
  }

  get contentWidth(): number {
    return this.#contentWidth;
  }

  override getContentWidth(width: number): number {
    const nextWidth = super.getContentWidth(width);
    if (nextWidth !== this.#contentWidth) {
      this.#captureBeforeWidthChange();
      this.#contentWidth = nextWidth;
    }
    return this.#contentWidth;
  }

  override updateLayout(
    contentHeight: number,
    viewportHeight: number,
    requestRender: () => void,
  ): void {
    super.updateLayout(contentHeight, viewportHeight, requestRender);
    const scrollTop = this.#desiredScrollTop();
    if (scrollTop !== null) {
      super.scrollTo(scrollTop, { disableFollow: true });
    }
  }

  focus(scrollTop: number): void {
    super.scrollTo(scrollTop, { disableFollow: true });
  }

  resumeFollowingEnd(): void {
    super.scrollToEnd();
  }

  override scrollTo(scrollTop: number, options?: ScrollViewScrollToOptions): void {
    this.#releasePosition();
    super.scrollTo(scrollTop, options);
  }

  override scrollBy(lines: number): number {
    this.#releasePosition();
    const moved = super.scrollBy(lines);
    if (lines !== 0) {
      this.#onScrollDirection?.(lines < 0 ? "up" : "down");
    }
    return moved;
  }

  override scrollToStart(): void {
    this.#releasePosition();
    super.scrollToStart();
  }

  override scrollToEnd(): void {
    this.#releasePosition();
    super.scrollToEnd();
  }

  setScrollListener(listener: ((direction: "up" | "down") => void) | undefined): void {
    this.#onScrollDirection = listener;
  }
}

export class TranscriptViewport {
  readonly document = new Container();
  readonly #anchors = new Map<string, Anchor>();
  readonly #semanticAnchors = new Map<string, Anchor>();
  #pendingPosition: ViewportPosition | null = null;
  readonly scrollView = new AnchoredScrollView(
    this.document,
    () => this.#desiredScrollTop(),
    () => {
      this.#pendingPosition = null;
    },
    () => this.#captureSemanticPosition(),
  );

  clear(): void {
    this.#captureSemanticPosition();
    this.document.clear();
    this.#anchors.clear();
    this.#semanticAnchors.clear();
  }

  setAnchor(id: string, component: Component, line: AnchorMetric = 0, height?: AnchorMetric): void {
    if (!this.#anchors.has(id)) {
      this.#anchors.set(id, {
        component,
        line: normalizeMetric(line),
        ...(height === undefined ? {} : { height: normalizeMetric(height) }),
      });
    }
  }

  setSemanticAnchor(
    id: string,
    component: Component,
    line: AnchorMetric = 0,
    height?: AnchorMetric,
  ): void {
    if (!this.#semanticAnchors.has(id)) {
      this.#semanticAnchors.set(id, {
        component,
        line: normalizeMetric(line),
        ...(height === undefined ? {} : { height: normalizeMetric(height) }),
      });
    }
  }

  setScrollListener(listener: ((direction: "up" | "down") => void) | undefined): void {
    this.scrollView.setScrollListener(listener);
  }

  preserveAnchorRow(id: string, width: number): boolean {
    const anchor = this.#anchors.get(id);
    if (anchor === undefined) {
      return false;
    }
    const anchorTop = this.#anchorTop(anchor, width);
    if (anchorTop === null) {
      return false;
    }
    const screenRow = anchorTop - this.scrollView.scrollTop;
    if (screenRow < 0 || screenRow >= this.scrollView.viewportHeight) {
      return false;
    }
    this.#pendingPosition = {
      anchorId: id,
      lineOffset: 0,
      screenRow,
    };
    return true;
  }

  focusOnNextLayout(id: string, screenRow = 0): void {
    this.#pendingPosition = {
      anchorId: id,
      lineOffset: 0,
      screenRow: Math.max(0, Math.trunc(screenRow)),
    };
  }

  selectVisibleAnchor(ids: readonly string[], width: number): string | null {
    const viewportStart = this.scrollView.scrollTop;
    const viewportEnd = viewportStart + this.scrollView.viewportHeight;
    const viewportCenter = viewportStart + Math.max(0, this.scrollView.viewportHeight - 1) / 2;
    const visible = ids
      .map((id) => {
        const anchor = this.#anchors.get(id);
        if (anchor === undefined) {
          return null;
        }
        const top = this.#anchorTop(anchor, width);
        if (top === null) {
          return null;
        }
        const height = this.#anchorHeight(anchor, width);
        return { id, top, bottom: top + height };
      })
      .filter(
        (candidate): candidate is NonNullable<typeof candidate> =>
          candidate !== null && candidate.bottom > viewportStart && candidate.top < viewportEnd,
      );
    const coveringCenter = visible.find(
      (candidate) => candidate.top <= viewportCenter && candidate.bottom > viewportCenter,
    );
    if (coveringCenter !== undefined) {
      return coveringCenter.id;
    }
    return (
      visible.sort((left, right) => {
        const leftDistance = Math.min(
          Math.abs(viewportCenter - left.top),
          Math.abs(viewportCenter - (left.bottom - 1)),
        );
        const rightDistance = Math.min(
          Math.abs(viewportCenter - right.top),
          Math.abs(viewportCenter - (right.bottom - 1)),
        );
        return leftDistance - rightDistance;
      })[0]?.id ?? null
    );
  }

  focus(id: string, width: number): boolean {
    const anchor = this.#anchors.get(id);
    if (anchor === undefined) {
      return false;
    }
    const scrollTop = this.#anchorTop(anchor, width);
    if (scrollTop === null) {
      return false;
    }
    this.#pendingPosition = { anchorId: id, lineOffset: 0, screenRow: 0 };
    this.scrollView.focus(scrollTop);
    return true;
  }

  followEnd(): void {
    this.#pendingPosition = null;
    this.scrollView.resumeFollowingEnd();
  }

  #captureSemanticPosition(): void {
    if (
      this.#pendingPosition !== null ||
      this.scrollView.isFollowingEnd ||
      this.#semanticAnchors.size === 0
    ) {
      return;
    }
    const width = this.scrollView.contentWidth;
    const scrollTop = this.scrollView.scrollTop;
    const positions = [...this.#semanticAnchors.entries()]
      .map(([anchorId, anchor]) => {
        const top = this.#anchorTop(anchor, width);
        if (top === null) {
          return null;
        }
        const height = this.#anchorHeight(anchor, width);
        return { anchorId, height, top };
      })
      .filter((position): position is NonNullable<typeof position> => position !== null)
      .sort((left, right) => left.top - right.top);
    const covering = positions.find(
      (position) => position.top <= scrollTop && position.top + position.height > scrollTop,
    );
    if (covering !== undefined) {
      this.#pendingPosition = {
        anchorId: covering.anchorId,
        lineOffset: scrollTop - covering.top,
        screenRow: 0,
      };
      return;
    }
    const below = positions.find((position) => position.top > scrollTop);
    if (below !== undefined) {
      this.#pendingPosition = {
        anchorId: below.anchorId,
        lineOffset: 0,
        screenRow: below.top - scrollTop,
      };
    }
  }

  #desiredScrollTop(): number | null {
    const position = this.#pendingPosition;
    if (position === null) {
      return null;
    }
    const anchor =
      this.#anchors.get(position.anchorId) ?? this.#semanticAnchors.get(position.anchorId);
    if (anchor === undefined) {
      return null;
    }
    const anchorTop = this.#anchorTop(anchor, this.scrollView.contentWidth);
    if (anchorTop === null) {
      return null;
    }
    const height = this.#anchorHeight(anchor, this.scrollView.contentWidth);
    const screenRow = Math.min(position.screenRow, Math.max(0, this.scrollView.viewportHeight - 1));
    return anchorTop + Math.min(position.lineOffset, height - 1) - screenRow;
  }

  #anchorTop(anchor: Anchor, width: number): number | null {
    const index = this.document.children.indexOf(anchor.component);
    return index < 0 ? null : this.#lineOffset(index, resolveMetric(anchor.line, width), width);
  }

  #anchorHeight(anchor: Anchor, width: number): number {
    return Math.max(
      1,
      anchor.height === undefined
        ? anchor.component.render(Math.max(1, width)).length - resolveMetric(anchor.line, width)
        : resolveMetric(anchor.height, width),
    );
  }

  #lineOffset(index: number, anchorLine: number, width: number): number {
    const boundedWidth = Math.max(1, width);
    return (
      this.document.children
        .slice(0, index)
        .reduce((lineCount, component) => lineCount + component.render(boundedWidth).length, 0) +
      anchorLine
    );
  }
}

function normalizeMetric(metric: AnchorMetric): AnchorMetric {
  return typeof metric === "number" ? Math.max(0, Math.trunc(metric)) : metric;
}

function resolveMetric(metric: AnchorMetric, width: number): number {
  const value = typeof metric === "number" ? metric : metric(Math.max(1, width));
  return Math.max(0, Math.trunc(value));
}
