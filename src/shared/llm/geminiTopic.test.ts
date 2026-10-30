import { describe, expect, it } from 'vitest';
import { askGeminiOnTopic, geminiTopicBody, parseTopicAnswer } from './geminiTopic';

const reply = (text: string) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });

describe('geminiTopicBody', () => {
  it('body sends only topics and text', () => {
    const body = JSON.stringify(geminiTopicBody(['AI'], 'Pasta recipe ex.com'));
    expect(body).toContain('Pasta recipe ex.com');
    expect(body).toContain('AI');
    expect(body).not.toContain('http');
  });
});

describe('parseTopicAnswer', () => {
  it('reads plain JSON', () => expect(parseTopicAnswer('{"onTopic":true}')).toBe(true));
  it('reads fenced JSON', () =>
    expect(parseTopicAnswer('```json\n{ "onTopic": false }\n```')).toBe(false));
  it('gives null for anything else', () => expect(parseTopicAnswer('maybe')).toBeNull());
  it('reads the text part of a response', () =>
    expect(parseTopicAnswer({ candidates: [{ content: { parts: [{ text: '{"onTopic":true}' }] } }] })).toBe(true));
});

describe('askGeminiOnTopic', () => {
  const opts = { apiKey: 'k', topics: ['AI'], text: 'Pasta recipe ex.com' };

  it('answers from the response', async () => {
    const fetch = async () => reply('{"onTopic":false}');
    expect(await askGeminiOnTopic({ ...opts, fetch })).toBe(false);
  });

  it.each([429, 500])('gives null on %i', async (status) => {
    const fetch = async () => new Response('{}', { status });
    expect(await askGeminiOnTopic({ ...opts, fetch })).toBeNull();
  });

  it('gives null when fetch throws', async () => {
    const fetch = async () => {
      throw new TypeError('offline');
    };
    expect(await askGeminiOnTopic({ ...opts, fetch })).toBeNull();
  });

  it('gives null on abort', async () => {
    const ac = new AbortController();
    ac.abort();
    const fetch = (_: RequestInfo | URL, init?: RequestInit) =>
      init?.signal?.aborted ? Promise.reject(new DOMException('aborted', 'AbortError')) : Promise.resolve(reply('{"onTopic":true}'));
    expect(await askGeminiOnTopic({ ...opts, signal: ac.signal, fetch: fetch as typeof globalThis.fetch })).toBeNull();
  });

  it('gives null on a malformed body', async () => {
    const fetch = async () => new Response('not json', { status: 200 });
    expect(await askGeminiOnTopic({ ...opts, fetch })).toBeNull();
  });

  it('gives null without a key and makes no call', async () => {
    let calls = 0;
    const fetch = async () => (calls++, reply('{"onTopic":true}'));
    expect(await askGeminiOnTopic({ ...opts, apiKey: '', fetch })).toBeNull();
    expect(calls).toBe(0);
  });

  it('key goes in the header, not the URL', async () => {
    let seen: { url: string; key: string | null } | undefined;
    const fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      seen = { url: String(url), key: new Headers(init?.headers).get('x-goog-api-key') };
      return reply('{"onTopic":true}');
    };
    await askGeminiOnTopic({ ...opts, apiKey: 'secret', fetch: fetch as typeof globalThis.fetch });
    expect(seen?.key).toBe('secret');
    expect(seen?.url).not.toContain('key=');
    expect(seen?.url).not.toContain('secret');
  });
});
