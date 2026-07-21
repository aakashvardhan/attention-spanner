import { describe, expect, it } from 'vitest';
import { extractSpeakableChunk, stripEmoji, ttsCleanText } from './tts';

describe('extractSpeakableChunk', () => {
  it('returns null while no sentence boundary has streamed in', () => {
    expect(extractSpeakableChunk('Your next task is')).toBeNull();
  });

  it('returns null for boundaries under the minimum chunk size', () => {
    expect(extractSpeakableChunk('1. Done.')).toBeNull();
  });

  it('takes everything up to the last complete sentence', () => {
    const text = 'You have 3 tasks open. The first one is “Email advisor”. The seco';
    const out = extractSpeakableChunk(text);
    expect(out).not.toBeNull();
    expect(out!.chunk).toBe('You have 3 tasks open. The first one is “Email advisor”.');
    expect(text.slice(out!.consumed)).toBe(' The seco');
  });

  it('honours quotes and brackets after terminal punctuation', () => {
    const out = extractSpeakableChunk('Your top task is “finish the draft.” Then rev');
    expect(out!.chunk).toBe('Your top task is “finish the draft.”');
  });

  it('matches a boundary at end-of-string', () => {
    const out = extractSpeakableChunk('Reading sprint started, stay on it now.');
    expect(out!.chunk).toBe('Reading sprint started, stay on it now.');
  });
});

describe('stripEmoji', () => {
  it('removes emoji and tidies leftover spacing', () => {
    expect(stripEmoji('Marked “Buy milk” as done. 🎉')).toBe('Marked “Buy milk” as done.');
    expect(stripEmoji('Gym 💪 logged 💪')).toBe('Gym logged');
  });

  it('handles variation selectors and ZWJ sequences', () => {
    expect(stripEmoji('Sunny ☀️ day with family 👨‍👩‍👧')).toBe('Sunny day with family');
  });

  it('keeps plain text and punctuation untouched', () => {
    expect(stripEmoji('2 tasks open; first up: “Email advisor”.')).toBe(
      '2 tasks open; first up: “Email advisor”.',
    );
  });
});

describe('ttsCleanText', () => {
  it('strips markdown syntax and links', () => {
    expect(ttsCleanText('**Bold** and `code` and [a link](https://x.test)')).toBe(
      'Bold and code and a link',
    );
  });

  it('replaces code blocks and collapses whitespace', () => {
    expect(ttsCleanText('before\n```js\nconst x = 1;\n```\nafter')).toBe(
      'before code block after',
    );
  });

  it('returns empty for empty-ish input', () => {
    expect(ttsCleanText('   ')).toBe('');
  });
});
