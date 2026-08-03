import { describe, expect, it } from 'vitest';
import {
  createSentenceSpeaker,
  extractSpeakableChunk,
  stripEmoji,
  ttsCleanText,
  type SpeechBackend,
} from './tts';

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

/** Records what was queued and lets the test decide when each utterance ends */
function fakeBackend() {
  const spoken: string[] = [];
  const pending: (() => void)[] = [];
  let stopped = 0;
  const backend: SpeechBackend = {
    speak: (text) => {
      spoken.push(text);
      return new Promise<void>((resolve) => pending.push(resolve));
    },
    stop: () => {
      stopped += 1;
      for (const resolve of pending.splice(0)) resolve();
    },
  };
  return {
    backend,
    spoken,
    stopCount: () => stopped,
    finishAll: () => {
      for (const resolve of pending.splice(0)) resolve();
    },
  };
}

describe('createSentenceSpeaker', () => {
  it('speaks completed sentences while the reply is still streaming', () => {
    const fake = fakeBackend();
    const speaker = createSentenceSpeaker(fake.backend);

    speaker.push('You have three tasks open');
    expect(fake.spoken).toEqual([]);
    expect(speaker.spoke()).toBe(false);

    speaker.push('You have three tasks open. The first is em');
    expect(fake.spoken).toEqual(['You have three tasks open.']);
    expect(speaker.spoke()).toBe(true);
  });

  it('speaks only the remainder on finish, never re-speaking a sentence', async () => {
    const fake = fakeBackend();
    const speaker = createSentenceSpeaker(fake.backend);

    speaker.push('You have three tasks open. The first is em');
    const done = speaker.finish('You have three tasks open. The first is email your advisor.');
    expect(fake.spoken).toEqual(['You have three tasks open.', 'The first is email your advisor.']);

    fake.finishAll();
    await expect(done).resolves.toBeUndefined();
  });

  it('waits for queued audio to drain before resolving finish', async () => {
    const fake = fakeBackend();
    const speaker = createSentenceSpeaker(fake.backend);
    speaker.push('Focus block started, stay on it now. Next');

    let settled = false;
    void speaker.finish('Focus block started, stay on it now. Next up is the draft.').then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    fake.finishAll();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(true);
  });

  it('fires onFirstUtterance once, just before any audio starts', () => {
    const fake = fakeBackend();
    let fired = 0;
    const speaker = createSentenceSpeaker(fake.backend, () => {
      fired += 1;
    });

    speaker.push('Your reading sprint is over. Take a break');
    speaker.push('Your reading sprint is over. Take a break now, seriously. And');
    expect(fired).toBe(1);
  });

  it('cancel stops the backend and speaks nothing further', async () => {
    const fake = fakeBackend();
    const speaker = createSentenceSpeaker(fake.backend);
    speaker.push('Your reading sprint is over. Take a break');
    speaker.cancel();

    expect(fake.stopCount()).toBe(1);
    speaker.push('Your reading sprint is over. Take a break now, seriously. And more.');
    await expect(speaker.finish('anything at all')).resolves.toBeUndefined();
    expect(fake.spoken).toEqual(['Your reading sprint is over.']);
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
