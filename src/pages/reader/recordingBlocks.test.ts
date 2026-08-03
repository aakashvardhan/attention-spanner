import { describe, expect, it } from 'vitest';
import { outlineOf } from '../../shared/articleExtract';
import { newRecording, type Recording } from '../../shared/recordings';
import { recordingBlocks, summaryBlocks } from './recordingBlocks';

function rec(patch: Partial<Recording> = {}): Recording {
  return { ...newRecording('r1', { kind: 'mic' }, 0, 'Lecture'), ...patch };
}

describe('summaryBlocks', () => {
  it('maps our own summary markdown to blocks', () => {
    const blocks = summaryBlocks('## Key idea\n- gradients flow backward\nPlain sentence.');
    expect(blocks).toEqual([
      { kind: 'heading', text: 'Key idea', level: 2 },
      { kind: 'list', text: 'gradients flow backward', level: 0 },
      { kind: 'para', text: 'Plain sentence.', level: 0 },
    ]);
  });

  it('strips inline emphasis the viewport would show raw', () => {
    expect(summaryBlocks('The **chain rule** and `grad`')[0].text).toBe('The chain rule and grad');
  });

  it('skips blank lines', () => {
    expect(summaryBlocks('a\n\n\nb')).toHaveLength(2);
  });

  it('is empty for an empty summary', () => {
    expect(summaryBlocks('')).toEqual([]);
  });
});

describe('recordingBlocks', () => {
  const full = rec({
    summary: '## Key idea\n- backprop',
    actionItems: ['Read chapter 4'],
    segments: [
      { startSec: 0, endSec: 300, text: 'First part.' },
      { startSec: 300, endSec: 600, text: 'Second part.' },
    ],
  });

  it('keeps generated action items out of the document flow', () => {
    const headings = recordingBlocks(full)
      .filter((b) => b.kind === 'heading' && b.level === 1)
      .map((b) => b.text);
    expect(headings).toEqual(['Summary', 'Transcript']);
  });

  it('precedes each segment with a timestamp heading', () => {
    const blocks = recordingBlocks(full);
    const transcript = blocks.slice(blocks.findIndex((b) => b.text === 'Transcript') + 1);
    expect(transcript.map((b) => b.text)).toEqual([
      '0:00',
      'First part.',
      '5:00',
      'Second part.',
    ]);
  });

  it('gives the outline a clickable timeline', () => {
    // The whole point of timestamps-as-headings: OutlineSidebar navigates them
    const outline = outlineOf(recordingBlocks(full)).map((h) => h.title);
    expect(outline).toContain('0:00');
    expect(outline).toContain('5:00');
  });

  it('omits sections that have no content', () => {
    const bare = rec({ segments: [{ startSec: 0, endSec: 10, text: 'Only speech.' }] });
    const texts = recordingBlocks(bare).map((b) => b.text);
    expect(texts).not.toContain('Summary');
    expect(texts).not.toContain('Action items');
    expect(texts).toContain('Transcript');
  });

  it('drops empty segments rather than emitting a bare timestamp', () => {
    const gappy = rec({
      segments: [
        { startSec: 0, endSec: 300, text: '   ' },
        { startSec: 300, endSec: 600, text: 'Real speech.' },
      ],
    });
    const texts = recordingBlocks(gappy).map((b) => b.text);
    expect(texts).not.toContain('0:00');
    expect(texts).toContain('5:00');
  });

  it('is empty for a recording with nothing in it', () => {
    expect(recordingBlocks(rec())).toEqual([]);
  });
});

describe('recordingBlocks visuals', () => {
  it('interleaves visuals into the owning segment window as quotes', () => {
    const r = rec({
      segments: [
        { startSec: 0, endSec: 300, text: 'intro' },
        { startSec: 300, endSec: 600, text: 'main' },
      ],
      visuals: [
        { atSec: 120, kind: 'auto' as const, description: 'title slide' },
        { atSec: 400, kind: 'manual' as const, description: 'a chart' },
      ],
    });
    const blocks = recordingBlocks(r);
    const texts = blocks.map((b) => `${b.kind}:${b.text}`);
    const intro = texts.indexOf('para:intro');
    const firstVisual = texts.findIndex((t) => t.includes('title slide'));
    const main = texts.indexOf('para:main');
    const secondVisual = texts.findIndex((t) => t.includes('a chart'));
    expect(intro).toBeGreaterThan(-1);
    expect(firstVisual).toBe(intro + 1);
    expect(secondVisual).toBe(main + 1);
    expect(blocks[firstVisual].kind).toBe('quote');
    expect(blocks[firstVisual].text).toContain('On screen at 2:00');
  });

  it('renders visuals under Transcript even with no spoken segments', () => {
    const r = rec({ visuals: [{ atSec: 10, kind: 'auto' as const, description: 'only slide' }] });
    const texts = recordingBlocks(r).map((b) => b.text);
    expect(texts).toContain('Transcript');
    expect(texts.some((t) => t.includes('only slide'))).toBe(true);
  });

  it('labels the summary provenance line', () => {
    const r = rec({ summary: '## A\n- point [0:10]' });
    const texts = recordingBlocks(r).map((b) => b.text);
    expect(texts.some((t) => t.includes('Generated from the transcript'))).toBe(true);
  });
});
