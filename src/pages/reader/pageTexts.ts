import type { PDFDocumentProxy } from 'pdfjs-dist';

/** pdf.js text items; marked-content items have no `str` and are skipped. */
interface TextItemLike {
  str?: string;
  hasEOL?: boolean;
}

/** Text split by page, line breaks rebuilt from `hasEOL`: Find, scan detection, section questions. */
export async function getPdfPageTexts(doc: PDFDocumentProxy): Promise<string[]> {
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items as TextItemLike[]) {
      if (typeof item.str !== 'string') continue;
      text += item.str;
      if (item.hasEOL) text += '\n';
    }
    pages.push(text);
  }
  return pages;
}
