import { ArticleReader } from './ArticleReader';
import { PdfReader } from './PdfReader';

/**
 * One reader, two document kinds. `?src=` opens a PDF (pdf.js, page boxes),
 * `?article=` opens a web article (fetched, extracted into reading blocks).
 * Both get the same toolbar, outline, highlights, notes and Ask panel.
 */
export function Reader() {
  const params = new URLSearchParams(location.search);
  const pdf = params.get('src') ?? '';
  const article = params.get('article') ?? '';

  if (pdf) return <PdfReader src={pdf} />;
  if (article) return <ArticleReader url={article} />;

  return (
    <div className="reader-fallback">
      <p>Nothing to show — open an article from your feed, or a PDF from the papers page.</p>
    </div>
  );
}
