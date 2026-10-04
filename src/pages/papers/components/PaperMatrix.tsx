import { useEffect, useState } from 'react';
import { useSettings } from '../../../shared/hooks/useSettings';
import { useStorageValue } from '../../../shared/hooks/useStorageValue';
import { layaReady } from '../../../shared/llm/laya';
import { buildMatrix, classifyRoles, MATRIX_COLUMNS, matrixMarkdown } from '../../../shared/llm/matrix';
import { articleReaderUrl, readerPageUrl } from '../../../shared/pdf';
import type { Annotation, Paper } from '../../../shared/types';

const LABEL = { claim: 'Claim', method: 'Method', result: 'Result', limitation: 'Limitation' };

/**
 * A deck's papers against what you highlighted in them, sorted by Laya into
 * claim / method / result / limitation. Roles are cached, so only new or
 * edited highlights are sent; with Laya off, the cached sorting still shows.
 */
export function PaperMatrix({ papers }: { papers: Paper[] }) {
  const [settings] = useSettings();
  const [annotations] = useStorageValue('annotations');
  const [roles] = useStorageValue('layaRoles');
  const [state, setState] = useState<'idle' | 'sorting' | 'off'>('idle');
  const [copied, setCopied] = useState(false);

  // A string key, so a re-render that hands over equal arrays does not re-sort.
  const key = `${papers.map((p) => p.id).join()}|${annotations.map((a) => `${a.id}:${a.updatedAt}`).join()}`;
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      if (!(await layaReady(settings.layaUrl))) {
        setState('off');
        return;
      }
      setState('sorting');
      await classifyRoles(settings.layaUrl, annotations, papers, controller.signal);
      if (!controller.signal.aborted) setState('idle');
    })();
    return () => controller.abort();
  }, [key, settings.layaUrl]);

  const rows = buildMatrix(papers, annotations, roles);

  const copy = async () => {
    await navigator.clipboard.writeText(matrixMarkdown(rows));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="pp-matrix">
      <div className="pp-matrix-bar">
        <p className="pp-fetch-msg">
          {state === 'sorting'
            ? 'Sorting your highlights…'
            : state === 'off'
              ? 'Laya is off, so new highlights are not sorted. Turn it on in Settings → Local AI.'
              : 'Each cell is the highlight that most clearly plays that role. Empty means none did.'}
        </p>
        <button type="button" className="ghost-btn" disabled={rows.length === 0} onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy as Markdown'}
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="panel fc-empty">
          <p>No highlights in this deck yet. Highlight passages while reading, and they land here.</p>
        </div>
      ) : (
        <div className="pp-matrix-scroll">
          <table className="pp-matrix-table">
            <thead>
              <tr>
                <th scope="col">Paper</th>
                {MATRIX_COLUMNS.map((c) => (
                  <th key={c} scope="col">
                    {LABEL[c]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ paper, cells }) => (
                <tr key={paper.id}>
                  <th scope="row">{paper.title}</th>
                  {MATRIX_COLUMNS.map((c) => (
                    <td key={c}>{cells[c] && <Cell annotation={cells[c]} />}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Cell({ annotation: a }: { annotation: Annotation }) {
  const href = a.anchor.kind === 'pdf' ? readerPageUrl(a.docUrl) : articleReaderUrl(a.docUrl);
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {a.text || a.note}
    </a>
  );
}
