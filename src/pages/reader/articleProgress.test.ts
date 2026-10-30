import { describe, expect, it } from 'vitest';
import { CONTINUE_MIN_SECONDS } from '../../shared/constants';
import { articleProgressReport } from './articleProgress';

const title = 'A long read';
const long = { hasText: true, scrollHeight: 9000, clientHeight: 900, scrollTop: 0 };
const short = { hasText: true, scrollHeight: 900, clientHeight: 900, scrollTop: 0 };

describe('articleProgressReport', () => {
  it('reports nothing before the article has rendered', () => {
    expect(articleProgressReport(title, { hasText: false, scrollHeight: 0, clientHeight: 0, scrollTop: 0 }, 0)).toBeNull();
    expect(articleProgressReport(title, { ...long, hasText: false }, 0)).toBeNull();
    expect(articleProgressReport(title, { ...long, clientHeight: 0, scrollHeight: 0 }, 0)).toBeNull();
  });

  it('a rendered, scrollable article at the top reports 0% with its title', () => {
    expect(articleProgressReport(title, long, 0)).toEqual({ percent: 0, title });
    expect(articleProgressReport(title, { ...long, scrollTop: 810 }, 0)).toEqual({ percent: 10, title });
  });

  it('an article that fits the viewport is 0% until the engagement minimum, then 100%', () => {
    expect(articleProgressReport(title, short, 0)).toEqual({ percent: 0, title });
    expect(articleProgressReport(title, short, CONTINUE_MIN_SECONDS - 1)).toEqual({ percent: 0, title });
    expect(articleProgressReport(title, short, CONTINUE_MIN_SECONDS)).toEqual({ percent: 100, title });
  });

  it('never reports without a title', () => {
    expect(articleProgressReport('', long, 0)).toBeNull();
    expect(articleProgressReport('', short, CONTINUE_MIN_SECONDS)).toBeNull();
  });
});
