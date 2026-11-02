import { readerPdfSrc } from '../../shared/pdf';
import { PdfReader } from './PdfReader';

/** The paper reader: `?src=` (or the PDF redirect's `?raw=`) opens a PDF. */
export function Reader() {
  // Web-accessible so the PDF redirect can land here; no business inside another site's frame.
  if (window.top !== window) return null;
  const pdf = readerPdfSrc(location.search);
  if (pdf) return <PdfReader src={pdf} />;
  return (
    <main className="reader-fallback">
      <p>Nothing to show. Open a paper from your shelf on the new tab.</p>
    </main>
  );
}
