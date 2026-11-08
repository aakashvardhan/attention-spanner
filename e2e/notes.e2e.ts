import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAGES, expectA11y, launch, seed, type Ext } from './harness';

/** The Notes page: every video with saved takeaways, read right there. */
describe('notes page', () => {
  let ext: Ext;
  beforeAll(async () => {
    ext = await launch();
  });
  afterAll(async () => ext?.close());

  it('says how to start when there are none', async () => {
    const page = await ext.page(PAGES.notes);
    await expect.poll(() => page.getByText('No notes yet.', { exact: false }).count()).toBe(1);
    await page.close();
  });

  it('lists videos newest first and shows one with links to its moments', async () => {
    await seed(ext, {
      videoNotes: {
        aaaaaaaaaaa: { id: 'aaaaaaaaaaa', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', title: 'Older lecture', kind: 'lecture', summary: 'Lecture summary.', cues: [{ t: '01:15', text: 'Why page tables?' }], notes: [{ t: '01:15', text: 'Page tables map addresses.' }], createdAt: 1_000 },
        bbbbbbbbbbb: { id: 'bbbbbbbbbbb', url: 'https://youtu.be/bbbbbbbbbbb', title: 'Newer explainer', kind: 'educational', summary: 'So it matters.', question: 'Why is the sky blue?', ideas: [{ t: '0:30', idea: 'Scattering', intuition: 'Short waves bounce more.' }], createdAt: 2_000 },
      },
    });
    const page = await ext.page(PAGES.notes);
    const titles = await page.locator('.notes-list button').allInnerTexts();
    expect(titles[0]).toContain('Newer explainer');
    expect(titles[1]).toContain('Older lecture');
    await page.locator('.notes-list button', { hasText: 'Older lecture' }).click();
    await expect.poll(() => page.getByText('Page tables map addresses.').count()).toBe(1);
    expect(await page.locator('a.stamp').first().getAttribute('href')).toBe('https://www.youtube.com/watch?v=aaaaaaaaaaa&t=75s');
    expect(await page.getByRole('link', { name: 'Watch on YouTube' }).getAttribute('href')).toBe('https://www.youtube.com/watch?v=aaaaaaaaaaa');
    expect(page.url()).toContain('#aaaaaaaaaaa');
    // Each moment says where it goes.
    // (the cue and the note are both at 1:15)
    expect(await page.getByRole('link', { name: '1:15, opens YouTube' }).count()).toBe(2);
    // Back and forward follow the picked video.
    await page.goBack();
    await expect.poll(() => page.getByText('Pick a video to read its notes.').count()).toBe(1);
    await page.goForward();
    await expect.poll(() => page.getByText('Page tables map addresses.').count()).toBe(1);
    await expectA11y(page, 'notes');
    // A link straight to one video's notes.
    const direct = await ext.page(`${PAGES.notes}#bbbbbbbbbbb`);
    await expect.poll(() => direct.getByText('Why is the sky blue?').count()).toBe(1);
  });

  it('shows notes taken a part at a time part by part, in time order', async () => {
    const st = (t: string, text: string) => ({ t, text });
    await seed(ext, {
      videoNotes: {
        ccccccccccc: {
          id: 'ccccccccccc', url: 'https://www.youtube.com/watch?v=ccccccccccc', title: 'Day-long course', kind: 'lecture', summary: '', createdAt: 3_000,
          // Parts added out of order, so the lists are too.
          cues: [st('2:30:00', 'Why TLBs?'), st('0:30:00', 'Why paging?')],
          notes: [st('2:45:00', 'TLBs cache.'), st('2:10:00', 'Misses walk tables.'), st('0:30:00', 'Paging splits memory.')],
          sections: [{ from: 0, to: 3600, summary: 'Part one, summed.' }, { from: 7200, to: 10800, summary: 'Part two, summed.' }],
        },
      },
    });
    const page = await ext.page(`${PAGES.notes}#ccccccccccc`);
    await expect.poll(() => page.locator('.notes-part-range').allInnerTexts()).toEqual(['0:00–1:00:00', '2:00:00–3:00:00']);
    const two = page.getByRole('region', { name: 'Part 2:00:00–3:00:00' });
    expect(await two.getByRole('region', { name: 'Notes' }).locator('li span').allInnerTexts()).toEqual(['Misses walk tables.', 'TLBs cache.']);
    expect(await two.getByText('Part two, summed.').count()).toBe(1);
    expect(await page.getByRole('region', { name: 'Part 0:00–1:00:00' }).getByText('Why paging?').count()).toBe(1);
    await expectA11y(page, 'notes-parts');
  });

  it('is linked from the new tab, next to Papers', async () => {
    const page = await ext.page(PAGES.newtab);
    const links = await page.locator('.edition-index .edition-link').allInnerTexts();
    expect(links.slice(0, 2)).toEqual(['Papers', 'Notes']);
    expect(await page.getByRole('link', { name: 'Notes' }).getAttribute('href')).toContain('src/pages/notes/index.html');
  });
});
