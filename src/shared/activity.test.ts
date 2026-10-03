import { describe, expect, it } from 'vitest';
import { addActivity, buildHeatModel, heatLevel, heatTooltip } from './activity';

// Friday, October 2, 2026, local time
const today = new Date(2026, 9, 2, 15, 0);

describe('addActivity', () => {
  it('counts a paper once a day and every finished focus session', () => {
    let log = addActivity({}, { paperId: 'a' }, today);
    const same = addActivity(log, { paperId: 'a' }, today);
    expect(same).toBe(log);
    log = addActivity(log, { paperId: 'b' }, today);
    log = addActivity(log, { focus: true }, today);
    log = addActivity(log, { focus: true }, today);
    expect(log['2026-10-02']).toEqual({ papers: ['a', 'b'], focus: 2 });
  });

  it('prunes days older than the calendar shows', () => {
    const log = addActivity({ '2024-01-01': { papers: ['x'], focus: 1 } }, { focus: true }, today);
    expect(Object.keys(log)).toEqual(['2026-10-02']);
  });
});

describe('buildHeatModel', () => {
  const log = {
    '2026-10-01': { papers: ['a'], focus: 3 },
    '2026-09-28': { papers: [], focus: 1 },
  };
  // Paper b was last read today and has no logged day: lastReadAt fills it in.
  const papers = [
    { id: 'a', lastReadAt: new Date(2026, 9, 1, 9).getTime() },
    { id: 'b', lastReadAt: today.getTime() },
    { id: 'c', lastReadAt: null },
  ];

  it('lays out 53 Sunday-first weeks ending with the week holding today', () => {
    const model = buildHeatModel(log, papers, 'all', today);
    expect(model.weeks).toHaveLength(53);
    expect(model.weeks.every((w) => w.length === 7)).toBe(true);
    const last = model.weeks[52];
    expect(last[0].date).toBe('2026-09-27');
    expect(last[5].date).toBe('2026-10-02');
    expect(last[6].level).toBeNull();
    expect(model.weeks[0][0].level).not.toBeNull();
  });

  it('merges lastReadAt into the log without double counting', () => {
    const model = buildHeatModel(log, papers, 'all', today);
    expect(model.papers).toBe(2);
    expect(model.focus).toBe(4);
    const day = model.weeks[52][4];
    expect(day).toMatchObject({ date: '2026-10-01', papers: 1, focus: 3, level: 4 });
  });

  it('shades by the chosen metric', () => {
    const papersOnly = buildHeatModel(log, papers, 'papers', today);
    expect(papersOnly.weeks[52][1]).toMatchObject({ date: '2026-09-28', level: 0 });
    expect(papersOnly.weeks[52][5].level).toBe(4);
    const focusOnly = buildHeatModel(log, papers, 'focus', today);
    expect(focusOnly.weeks[52][1].level).toBe(2);
  });

  it('labels each month once, at its first column', () => {
    const labels = buildHeatModel({}, [], 'all', today).months.map((m) => m.label);
    expect(labels.filter((l) => l === 'Oct')).toHaveLength(1);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('heatLevel', () => {
  it('uses quartiles of the busiest day, with any activity at least 1', () => {
    expect([0, 1, 4, 5, 8].map((n) => heatLevel(n, 8))).toEqual([0, 1, 2, 3, 4]);
    expect(heatLevel(3, 0)).toBe(0);
  });
});

describe('heatTooltip', () => {
  it('reads like GitHub', () => {
    expect(heatTooltip({ date: '2026-10-01', papers: 1, focus: 3, level: 4 })).toBe(
      '1 paper and 3 focus sessions on Thursday, October 1',
    );
    expect(heatTooltip({ date: '2026-10-01', papers: 0, focus: 0, level: 0 })).toBe(
      'No reading or focus on Thursday, October 1',
    );
  });
});
