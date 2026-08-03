import { describe, expect, it } from 'vitest';
import {
  VISION_DESC_MAX_CHARS,
  VISION_DIFF_THRESHOLD,
  VISION_MIN_SEND_GAP_MS,
} from '../constants';
import { MAX_AUTO_VISUALS } from '../recordings';
import { buildDescribePrompt, cleanDescription, frameDelta, shouldCapture } from './vision';

describe('cleanDescription', () => {
  it('strips code fences and trims', () => {
    expect(cleanDescription('```\nSlide: Attention Is All You Need\n```')).toBe(
      'Slide: Attention Is All You Need',
    );
  });

  it('maps the NOTHING_NEW sentinel to empty', () => {
    expect(cleanDescription('NOTHING_NEW')).toBe('');
    expect(cleanDescription('  nothing_new  ')).toBe('');
    expect(cleanDescription('The frame shows NOTHING_NEW beyond the prior slide.')).toBe('');
  });

  it('caps at the description budget', () => {
    expect(cleanDescription('x'.repeat(VISION_DESC_MAX_CHARS + 100))).toHaveLength(
      VISION_DESC_MAX_CHARS,
    );
  });

  it('keeps ordinary descriptions', () => {
    expect(cleanDescription('A bar chart of revenue by quarter.')).toBe(
      'A bar chart of revenue by quarter.',
    );
  });
});

describe('frameDelta', () => {
  it('is 0 for identical grids and 1 for black vs white', () => {
    expect(frameDelta([10, 20, 30], [10, 20, 30])).toBe(0);
    expect(frameDelta([0, 0], [255, 255])).toBe(1);
  });

  it('treats a length mismatch as fully different', () => {
    expect(frameDelta([1, 2], [1, 2, 3])).toBe(1);
    expect(frameDelta([], [])).toBe(1);
  });

  it('is the normalized mean of per-cell differences', () => {
    // deltas 51 and 0 → mean 25.5 → /255 = 0.1
    expect(frameDelta([51, 100], [0, 100])).toBeCloseTo(0.1);
  });
});

describe('shouldCapture', () => {
  const firing = {
    deltaVsSent: VISION_DIFF_THRESHOLD + 0.01,
    deltaVsPrev: 0,
    msSinceLastSend: VISION_MIN_SEND_GAP_MS,
    autoCount: 0,
  };

  it('fires on a settled, changed, affordable frame', () => {
    expect(shouldCapture(firing)).toBe(true);
  });

  it('holds while the scene is still moving (playing video)', () => {
    expect(shouldCapture({ ...firing, deltaVsPrev: 0.5 })).toBe(false);
  });

  it('holds when nothing changed since the last sent frame', () => {
    expect(shouldCapture({ ...firing, deltaVsSent: 0 })).toBe(false);
  });

  it('holds inside the send gap and at the auto cap', () => {
    expect(shouldCapture({ ...firing, msSinceLastSend: VISION_MIN_SEND_GAP_MS - 1 })).toBe(false);
    expect(shouldCapture({ ...firing, autoCount: MAX_AUTO_VISUALS })).toBe(false);
  });
});

describe('buildDescribePrompt', () => {
  it('is minimal with no context', () => {
    expect(buildDescribePrompt('', '')).toBe('Describe this frame.');
  });

  it('includes the prior description and the transcript tail', () => {
    const prompt = buildDescribePrompt('gradient descent converges', 'Slide 3: optimizers');
    expect(prompt).toContain('Slide 3: optimizers');
    expect(prompt).toContain('gradient descent converges');
  });
});
