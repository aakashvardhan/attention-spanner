import { describe, expect, it } from 'vitest';
import { completeLink, openLink } from './useLinkAutocomplete';

describe('openLink', () => {
  it('finds the link being typed at the caret', () => {
    const text = 'Following up on [[diff';

    expect(openLink(text, text.length)).toEqual({ start: 16, query: 'diff' });
  });

  it('offers everything the moment the brackets open', () => {
    const text = 'Note about [[';

    expect(openLink(text, text.length)).toEqual({ start: 11, query: '' });
  });

  // Once a link is closed it is not still being typed; continuing to suggest
  // would put a second list over text the user has moved past.
  it('ignores a link that is already closed', () => {
    const text = 'About [[Some Paper]] and more';

    expect(openLink(text, text.length)).toBe(null);
  });

  // `[[` on an earlier line is abandoned, not open. Without this the list
  // reappears while typing an unrelated paragraph.
  it('ignores an unclosed bracket left on an earlier line', () => {
    const text = 'I typed [[ then gave up\nand wrote something else';

    expect(openLink(text, text.length)).toBe(null);
  });

  it('reports nothing when there are no brackets at all', () => {
    expect(openLink('just a plain note', 17)).toBe(null);
  });

  // The caret can sit before a link typed later in the note.
  it('looks only at text before the caret', () => {
    const text = 'start [[later';

    expect(openLink(text, 5)).toBe(null);
  });
});

describe('completeLink', () => {
  it('replaces the partial link and leaves a trailing space to keep typing', () => {
    const text = 'Following up on [[diff';

    expect(completeLink(text, text.length, 'Denoising Diffusion')).toBe(
      'Following up on [[Denoising Diffusion]] ',
    );
  });

  it('keeps whatever follows the caret', () => {
    const text = 'See [[diff today';
    // caret sits right after "diff"
    expect(completeLink(text, 10, 'Denoising Diffusion')).toBe(
      'See [[Denoising Diffusion]]  today',
    );
  });

  it('changes nothing when no link is open', () => {
    expect(completeLink('plain text', 10, 'A Paper')).toBe('plain text');
  });
});
