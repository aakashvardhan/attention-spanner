import { describe, expect, it } from 'vitest';
import { applyReaderProgress, type ReaderPosition } from './papers';
import type { Paper } from '../shared/types';

const T0 = 1_700_000_000_000;

function paper(over: Partial<Paper> = {}): Paper {
  return {
    id: 'p1',
    deckId: 'd1',
    title: 'Denoising Diffusion Probabilistic Models',
    authors: 'Ho, Jain, Abbeel',
    venue: 'NeurIPS',
    year: 2020,
    citations: null,
    url: 'https://arxiv.org/abs/2006.11239',
    abstract: '',
    relevance: '',
    status: 'to-read',
    progressPercent: 0,
    leftOff: '',
    addedAt: T0,
    updatedAt: T0,
    lastReadAt: null,
    ...over,
  };
}

function pos(over: Partial<ReaderPosition> = {}): ReaderPosition {
  return {
    pdfUrl: 'https://arxiv.org/pdf/2006.11239',
    page: 5,
    pageCount: 20,
    offset: 0.5,
    leftOff: '3 Diffusion models',
    ...over,
  };
}

describe('applyReaderProgress', () => {
  it('stores the position, ratchets percent, and promotes to-read → reading', () => {
    const p = paper();
    expect(applyReaderProgress(p, pos(), T0 + 1000)).toBe(true);
    expect(p.pdf).toEqual({ url: 'https://arxiv.org/pdf/2006.11239', page: 5, pageCount: 20, offset: 0.5 });
    expect(p.progressPercent).toBe(23); // (4 + 0.5) / 20
    expect(p.status).toBe('reading');
    expect(p.leftOff).toBe('3 Diffusion models');
    expect(p.lastReadAt).toBe(T0 + 1000);
    expect(p.updatedAt).toBe(T0 + 1000);
  });

  it('never lowers progressPercent when scrolling back up', () => {
    const p = paper({ status: 'reading', progressPercent: 60 });
    applyReaderProgress(p, pos({ page: 2, offset: 0 }), T0 + 1000);
    expect(p.progressPercent).toBe(60);
    expect(p.pdf?.page).toBe(2); // resume position still follows the reader
  });

  it('leaves a finished paper marked read', () => {
    const p = paper({ status: 'read', progressPercent: 100 });
    applyReaderProgress(p, pos(), T0 + 1000);
    expect(p.status).toBe('read');
  });

  it('keeps the existing leftOff when the reader reports an empty one', () => {
    const p = paper({ leftOff: 'my own note' });
    applyReaderProgress(p, pos({ leftOff: '' }), T0 + 1000);
    expect(p.leftOff).toBe('my own note');
  });

  it('throttles lastReadAt but always bumps updatedAt on a position change', () => {
    const p = paper({ status: 'reading', lastReadAt: T0 });
    applyReaderProgress(p, pos(), T0 + 5000); // inside the 60s throttle
    expect(p.lastReadAt).toBe(T0);
    expect(p.updatedAt).toBe(T0 + 5000);
    applyReaderProgress(p, pos({ page: 6 }), T0 + 61_000);
    expect(p.lastReadAt).toBe(T0 + 61_000);
  });

  it('reports no change for an identical repeat inside the throttle window', () => {
    const p = paper();
    applyReaderProgress(p, pos(), T0 + 1000);
    expect(applyReaderProgress(p, pos(), T0 + 2000)).toBe(false);
    expect(p.updatedAt).toBe(T0 + 1000);
  });

  it('clamps out-of-range pages and offsets', () => {
    const p = paper();
    applyReaderProgress(p, pos({ page: 99, offset: 7 }), T0 + 1000);
    expect(p.pdf).toMatchObject({ page: 20, offset: 1 });
    expect(p.progressPercent).toBe(100);
  });
});
