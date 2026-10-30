import { describe, expect, it } from 'vitest';
import { REFRAME_SYSTEM, parseReframe } from './brainDump';

describe('parseReframe', () => {
  it('reads dash bullets', () => {
    expect(parseReframe('- a\n- b')).toEqual(['a', 'b']);
  });

  it('drops a preamble and accepts other bullet marks', () => {
    expect(parseReframe('Here is a lighter version:\n\n* a\n• b\n1. c\n')).toEqual(['a', 'b', 'c']);
  });

  it('finds nothing in plain prose', () => {
    expect(parseReframe('just prose with no bullets')).toEqual([]);
  });

  it('keeps at most six', () => {
    expect(parseReframe('- 1\n- 2\n- 3\n- 4\n- 5\n- 6\n- 7\n- 8')).toHaveLength(6);
  });
});

describe('REFRAME_SYSTEM', () => {
  it('asks for dash bullets and nothing of the old sorter', () => {
    expect(REFRAME_SYSTEM).toContain('- ');
    expect(REFRAME_SYSTEM).not.toContain('Eisenhower');
  });
});
