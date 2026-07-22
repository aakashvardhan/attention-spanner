import { useEffect, useState } from 'react';
import {
  extractArticle,
  outlineOf,
  type ArticleBlock,
} from '../../shared/articleExtract';
import type { FlatOutlineItem } from '../../shared/pdfOutline';

/**
 * Fetch an article and turn it into reading blocks. Mirrors usePdfDocument's
 * state shape so the reader shell can treat both document kinds the same way.
 *
 * The cross-origin fetch works because extension pages run under the
 * manifest's host_permissions — the same reason usePdfDocument can pull a PDF
 * straight off arxiv.org.
 */

export type ArticleLoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      title: string;
      blocks: ArticleBlock[];
      /** Headings, shaped like the PDF outline so OutlineSidebar is shared */
      outline: FlatOutlineItem[];
    };

/** Blocks as plain strings — what the text anchors index against. */
export function blockTexts(blocks: readonly ArticleBlock[]): string[] {
  return blocks.map((b) => b.text);
}

export function useArticleDocument(url: string): ArticleLoadState {
  const [state, setState] = useState<ArticleLoadState>({ status: 'loading' });

  useEffect(() => {
    if (!url) return;
    let alive = true;
    setState({ status: 'loading' });

    void (async () => {
      try {
        const response = await fetch(url, { credentials: 'include' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const type = response.headers.get('content-type') ?? '';
        if (type && !/html|xml|text\/plain/i.test(type)) {
          throw new Error(`That URL is ${type.split(';')[0]}, not an article.`);
        }
        const html = await response.text();
        if (!alive) return;

        const doc = new DOMParser().parseFromString(html, 'text/html');
        const { title, blocks } = extractArticle(doc, url);
        if (blocks.length === 0) {
          throw new Error("Couldn't find readable text on that page.");
        }
        setState({
          status: 'ready',
          title,
          blocks,
          outline: outlineOf(blocks).map((h) => ({
            title: h.title,
            level: h.level,
            page: h.blockIndex,
          })),
        });
      } catch (error) {
        if (!alive) return;
        setState({
          status: 'error',
          message:
            error instanceof Error
              ? `Couldn't load that article (${error.message}).`
              : "Couldn't load that article.",
        });
      }
    })();

    return () => {
      alive = false;
    };
  }, [url]);

  return state;
}
