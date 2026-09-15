import { ArticleReader } from './ArticleReader';
import { PdfReader } from './PdfReader';

/**
 * One reader, two document kinds. `?src=` opens a PDF (pdf.js, page boxes) and
 * `?article=` opens a web article (fetched, extracted into reading blocks).
 * Both get the same toolbar, outline, highlights and notes.
 */
export function Reader() {
  const params = new URLSearchParams(location.search);
  const pdf = params.get('src') ?? '';
  const article = params.get('article') ?? '';

  if (pdf) return <PdfReader src={pdf} />;
  if (article) return <ArticleReader url={article} />;

  return (
    <div className="reader-fallback">
      <p>
        Nothing to show — press ⌘/Ctrl+Shift+E on a page to read it here, right-click and
        choose “Read in Reader”, or pick something up from Continue reading on a new tab.
      </p>
    </div>
  );
}
