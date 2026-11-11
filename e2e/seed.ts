/** The storage shapes the suite seeds (rust/core/src/types.rs is the source of truth). */
export interface Folder {
  id: string;
  name: string;
  type: string;
}
export interface Paper {
  id: string;
  title: string;
  authors: string;
  year: number | null;
  url: string;
  folderIds: string[];
  progressPercent: number;
  leftOff: string;
  pdf?: { url: string; page: number; pageCount: number; offset: number };
  addedAt: number;
  updatedAt: number;
  lastReadAt: number | null;
}

const HOUR = 60 * 60_000;

export const folder: Folder = { id: '01985f0e-9788-7c5f-9cff-fbf84379ca7a', name: 'Reading', type: 'default-reading' };

/** A shelved arXiv paper; `n` picks a distinct id like 2601.00001. */
export function paper(n: string, title: string, overrides: Partial<Paper> = {}): Paper {
  const now = Date.now();
  const id = `2601.${n.padStart(5, '0')}`;
  return {
    id,
    title,
    authors: 'A. Author',
    year: 2026,
    url: `https://arxiv.org/abs/${id}`,
    folderIds: [folder.id],
    progressPercent: 30,
    leftOff: '',
    addedAt: now - 48 * HOUR,
    updatedAt: now - HOUR,
    lastReadAt: now - HOUR,
    ...overrides,
  };
}

const LINE = 'The transformer reads a sentence and BLEU scores the translation it writes back out.';

/** A minimal valid PDF: each page holds a few lines of plain Helvetica text; with `outline`, each page is a section. */
export function makePdf(pages: number, outline = false): Buffer {
  const root = 3 + pages * 2;
  const objs: string[] = [`<< /Type /Catalog /Pages 2 0 R${outline ? ` /Outlines ${root} 0 R` : ''} >>`];
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  for (let i = 0; i < pages; i++) {
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R ` +
        '/Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>',
    );
    const lines = Array.from({ length: 6 }, (_, l) => `1 0 0 1 72 ${700 - l * 40} Tm (${LINE}) Tj`).join(' ');
    const stream = `BT /F1 11 Tf ${lines} ET`;
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  if (outline) {
    objs.push(`<< /Type /Outlines /First ${root + 1} 0 R /Last ${root + pages} 0 R /Count ${pages} >>`);
    for (let i = 0; i < pages; i++) {
      const sib = `${i > 0 ? ` /Prev ${root + i} 0 R` : ''}${i < pages - 1 ? ` /Next ${root + i + 2} 0 R` : ''}`;
      objs.push(`<< /Title (Section ${i + 1}) /Parent ${root} 0 R /Dest [${3 + i * 2} 0 R /XYZ 0 792 0]${sib} >>`);
    }
  }
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A 1.5 s, 220 Hz tone at 24 kHz: speech enough that the silence trim keeps it. */
export function toneWav(seconds = 1.5): Buffer {
  const n = Math.round(24_000 * seconds);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24_000, 24);
  b.writeUInt32LE(48_000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / 24_000)), 44 + i * 2);
  return b;
}
