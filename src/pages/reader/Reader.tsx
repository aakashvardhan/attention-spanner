import { ArticleReader } from './ArticleReader';
import { PdfReader } from './PdfReader';
import { RecordingReader } from './RecordingReader';

/**
 * One reader, three document kinds. `?src=` opens a PDF (pdf.js, page boxes),
 * `?article=` opens a web article (fetched, extracted into reading blocks), and
 * `?recording=` opens the transcript of a recorded lecture or meeting. All
 * three get the same toolbar, outline, highlights, notes and Ask panel.
 */
export function Reader() {
  const params = new URLSearchParams(location.search);
  const pdf = params.get('src') ?? '';
  const article = params.get('article') ?? '';
  const recording = params.get('recording') ?? '';

  if (pdf) return <PdfReader src={pdf} />;
  if (article) return <ArticleReader url={article} />;
  if (recording) return <RecordingReader id={recording} />;

  return (
    <div className="reader-fallback">
      <p>
        Nothing to show — press ⌘/Ctrl+Shift+E on a page to read it here, right-click and
        choose “Read in Reader”, or pick something up from Continue reading on a new tab.
      </p>
    </div>
  );
}
