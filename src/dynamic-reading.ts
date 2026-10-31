import {
  extract,
  highlightRule,
  type Token,
  type WordState,
  type ReadingSettings,
  type HighlightStyle,
} from "./reading";

const blockSelector =
  "p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,figcaption,div,section,article,main,header,aside,body";
export const textBlock = (node: Node): Element | null =>
  node.parentElement?.closest(blockSelector) ?? node.parentElement;
type HighlightSet = { add(range: Range): void; delete(range: Range): void };

/** One serial queue per reading session. Nothing in this cache is persisted. */
export class DynamicReading {
  private blocks = new Map<Element, Token[]>();
  private pending = new Set<Element>();
  private revisions = new Map<Element, number>();
  private revision = 0;
  private known = new Set<string>(); // Also caches Keys absent from Anki.
  readonly states: Record<string, WordState> = {};
  private resolved = new Map<string, { key: string; entry: Token["entry"] }>();
  private stopped = false;
  private draining = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private config: ReadingSettings,
    private highlights: Record<HighlightStyle, HighlightSet>,
    private lookup: (keys: string[]) => Promise<Record<string, WordState>>,
    private failed: () => void,
    private changed: (tokens: Token[]) => void = () => {},
    private resolve?: (
      words: string[],
    ) => Promise<Record<string, { key: string; entry: Token["entry"] }>>,
  ) {}
  get tokens() {
    return [...this.blocks.values()].flat();
  }
  tokensFor(element: Element | null) {
    const block = element?.closest(blockSelector);
    return block ? (this.blocks.get(block) ?? []) : [];
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.pending.clear();
    this.blocks.clear();
    this.revisions.clear();
    this.resolved.clear();
  }
  private remove(block: Element) {
    for (const token of this.blocks.get(block) ?? [])
      if (token.style) this.highlights[token.style].delete(token.range);
    this.blocks.delete(block);
  }
  private enqueue(block: Element) {
    this.remove(block);
    this.revisions.set(block, ++this.revision);
    this.pending.add(block);
  }
  private discover(root: Node) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Node[] = root.nodeType === Node.TEXT_NODE ? [root] : [];
    for (let node = walker.nextNode(); node; node = walker.nextNode())
      nodes.push(node);
    for (const node of nodes) {
      if (
        !node.textContent?.trim() ||
        node.parentElement?.closest("#voka-drawer,script,style")
      )
        continue;
      const block = textBlock(node);
      if (block && !this.pending.has(block)) this.enqueue(block);
    }
  }
  start(root: Node) {
    this.discover(root);
    return this.drain();
  }
  update(records: MutationRecord[]) {
    if (this.stopped) return;
    for (const record of records) {
      if (record.target.nodeType === Node.TEXT_NODE) {
        const block = textBlock(record.target);
        if (block) this.enqueue(block);
      } else if (record.type === "attributes") {
        for (const block of this.blocks.keys())
          if ((record.target as Element).contains(block)) this.enqueue(block);
        this.discover(record.target);
      } else {
        // Removed text changes its owning block; added subtrees discover only new blocks.
        const owner =
          record.target instanceof Element
            ? record.target.closest(blockSelector)
            : textBlock(record.target);
        if (owner && (this.blocks.has(owner) || this.pending.has(owner)))
          this.enqueue(owner);
        for (const node of Array.from(record.addedNodes)) this.discover(node);
      }
    }
    for (const block of this.revisions.keys())
      if (!block.isConnected) {
        this.remove(block);
        this.pending.delete(block);
        this.revisions.delete(block);
      }
    // Fixed-window throttle: continuous mutations cannot postpone work indefinitely.
    if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.drain().catch(this.failed);
      }, 100);
  }
  private async drain() {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      while (this.pending.size && !this.stopped) {
        const batch: { block: Element; revision: number; tokens: Token[] }[] =
          [];
        const began = performance.now();
        for (const block of this.pending) {
          this.pending.delete(block);
          if (!block.isConnected) continue;
          batch.push({
            block,
            revision: this.revisions.get(block)!,
            tokens: extract(
              block,
              undefined,
              (node) => textBlock(node) === block,
            ),
          });
          if (performance.now() - began >= 8 || batch.length >= 32) break;
        }
        // Resolve new surface forms once per session before querying canonical Anki Keys.
        const tokens = batch.flatMap((item) => item.tokens);
        if (this.resolve) {
          const words = [
            ...new Set(tokens.map((token) => token.entry.lemma)),
          ].filter((word) => !this.resolved.has(word));
          if (words.length) {
            const matches = await this.resolve(words);
            if (this.stopped) return;
            for (const [word, match] of Object.entries(matches))
              this.resolved.set(word, match);
          }
          for (const token of tokens) {
            const match = this.resolved.get(token.entry.lemma);
            if (match) {
              token.key = match.key;
              token.entry = match.entry;
              token.recognized = true;
            }
          }
        }
        const keys = [
          ...new Set(
            batch.flatMap((item) => item.tokens.map((token) => token.key)),
          ),
        ].filter((key) => !this.known.has(key));
        if (keys.length) {
          const states = await this.lookup(keys);
          if (this.stopped) return;
          Object.assign(this.states, states);
          keys.forEach((key) => this.known.add(key));
        }
        for (const { block, revision, tokens } of batch) {
          if (!block.isConnected || revision !== this.revisions.get(block))
            continue;
          this.remove(block);
          for (const token of tokens) {
            const state = this.states[token.key];
            if (state) {
              token.recognized = true;
              token.entry = {
                ...token.entry,
                lemma: state.fields.Word || token.entry.lemma,
              };
            }
            token.style = highlightRule(
              token.entry.level || state?.level,
              this.config,
              state,
            );
            if (token.style) this.highlights[token.style].add(token.range);
          }
          this.blocks.set(block, tokens);
        }
        // Yield between bounded batches so rendering/input can run on long pages.
        if (this.pending.size)
          await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      this.draining = false;
      if (!this.stopped) this.changed(this.tokens);
    }
  }
}
