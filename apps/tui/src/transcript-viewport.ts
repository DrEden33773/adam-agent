import {
  type Component,
  Container,
  ScrollView,
  type ScrollViewScrollToOptions,
} from "@earendil-works/pi-tui";

class AnchoredScrollView extends ScrollView {
  readonly #focusedScrollTop: () => number | null;
  readonly #releaseFocus: () => void;
  #contentWidth = 1;

  constructor(
    component: Component,
    focusedScrollTop: () => number | null,
    releaseFocus: () => void,
  ) {
    super(component, { follow: "end", overscroll: "chain", primary: true });
    this.#focusedScrollTop = focusedScrollTop;
    this.#releaseFocus = releaseFocus;
  }

  get contentWidth(): number {
    return this.#contentWidth;
  }

  override getContentWidth(width: number): number {
    this.#contentWidth = super.getContentWidth(width);
    return this.#contentWidth;
  }

  override updateLayout(
    contentHeight: number,
    viewportHeight: number,
    requestRender: () => void,
  ): void {
    super.updateLayout(contentHeight, viewportHeight, requestRender);
    const scrollTop = this.#focusedScrollTop();
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
    this.#releaseFocus();
    super.scrollTo(scrollTop, options);
  }

  override scrollBy(lines: number): number {
    this.#releaseFocus();
    return super.scrollBy(lines);
  }

  override scrollToStart(): void {
    this.#releaseFocus();
    super.scrollToStart();
  }

  override scrollToEnd(): void {
    this.#releaseFocus();
    super.scrollToEnd();
  }
}

export class TranscriptViewport {
  readonly document = new Container();
  readonly #anchors = new Map<string, { readonly component: Component; readonly line: number }>();
  #focusedAnchorId: string | null = null;
  readonly scrollView = new AnchoredScrollView(
    this.document,
    () => this.#focusedScrollTop(),
    () => {
      this.#focusedAnchorId = null;
    },
  );

  clear(): void {
    this.document.clear();
    this.#anchors.clear();
  }

  setAnchor(id: string, component: Component, line = 0): void {
    if (!this.#anchors.has(id)) {
      this.#anchors.set(id, { component, line: Math.max(0, Math.trunc(line)) });
    }
  }

  focus(id: string, width: number): boolean {
    this.#focusedAnchorId = id;
    const anchor = this.#anchors.get(id);
    if (anchor === undefined) {
      return false;
    }
    const index = this.document.children.indexOf(anchor.component);
    if (index < 0) {
      return false;
    }
    const scrollTop = this.#lineOffset(index, anchor.line, width);
    this.scrollView.focus(scrollTop);
    return true;
  }

  followEnd(): void {
    this.#focusedAnchorId = null;
    this.scrollView.resumeFollowingEnd();
  }

  #focusedScrollTop(): number | null {
    const anchor =
      this.#focusedAnchorId === null ? undefined : this.#anchors.get(this.#focusedAnchorId);
    if (anchor === undefined) {
      return null;
    }
    const index = this.document.children.indexOf(anchor.component);
    return index < 0 ? null : this.#lineOffset(index, anchor.line, this.scrollView.contentWidth);
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
