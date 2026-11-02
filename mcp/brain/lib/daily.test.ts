import { describe, expect, it } from 'vitest';
import { dailyHeading, dailyPath, dailyText, ymd } from './daily';

describe('daily notes', () => {
  const d = new Date(2026, 9, 14, 23, 59);
  it('names the file by the local date and writes only the heading', () => {
    expect(ymd(d)).toBe('2026-10-14');
    expect(dailyPath(d)).toBe('daily/2026-10-14.md');
    expect(dailyHeading(d)).toBe('Wednesday, 14 October 2026');
    expect(dailyText(d)).toBe('# Wednesday, 14 October 2026\n');
  });
});
