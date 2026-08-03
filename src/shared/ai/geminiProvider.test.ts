import { afterEach, describe, expect, it, vi } from 'vitest';
import { newTurn } from './assistantTypes';
import {
  buildGeminiBody,
  fetchWithRetry,
  friendlyHttpError,
  parseRetryAfterMs,
  parseGeminiResponse,
  parseSseData,
  retryDelayMs,
  toFunctionDeclaration,
} from './geminiProvider';
import type { Tool } from './tools';

const tool: Tool = {
  name: 'add_task',
  description: 'Add a task',
  params: {
    type: 'object',
    required: ['text'],
    additionalProperties: false,
    properties: {
      text: { type: 'string', description: 'task text', maxLength: 300 },
      page: { type: 'string', description: 'page', enum: ['a', 'b'] },
      cards: { type: 'array', description: 'cards', items: { type: 'object' } },
    },
  },
  summary: () => '',
  run: async () => '',
};

describe('toFunctionDeclaration', () => {
  it('maps name/description/required and drops unsupported keywords', () => {
    const decl = toFunctionDeclaration(tool) as {
      name: string;
      parameters: { properties: Record<string, Record<string, unknown>>; required: string[] };
    };
    expect(decl.name).toBe('add_task');
    expect(decl.parameters.required).toEqual(['text']);
    expect(decl.parameters.properties.text).toEqual({ type: 'string', description: 'task text' });
    expect(decl.parameters.properties.page.enum).toEqual(['a', 'b']);
    expect(decl.parameters.properties.cards.items).toEqual({ type: 'object' });
    expect(decl.parameters.properties.text).not.toHaveProperty('maxLength');
    expect(decl.parameters).not.toHaveProperty('additionalProperties');
  });
});

describe('buildGeminiBody', () => {
  it('maps roles, system instruction, and response schema', () => {
    const body = buildGeminiBody({
      system: 'be brief',
      turns: [newTurn('user', 'hi'), newTurn('assistant', 'hello'), newTurn('user', 'again')],
      responseSchema: { type: 'object' },
    }) as {
      systemInstruction: { parts: { text: string }[] };
      contents: { role: string; parts: { text: string }[] }[];
      generationConfig: { responseMimeType: string };
    };
    expect(body.systemInstruction.parts[0].text).toBe('be brief');
    expect(body.contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
  });

  it('attaches audio to the last turn only, after its text', () => {
    const body = buildGeminiBody({
      system: 'transcribe',
      turns: [newTurn('user', 'earlier'), newTurn('user', 'transcribe this')],
      audio: { mimeType: 'audio/webm', dataBase64: 'AAAA' },
    }) as {
      contents: { parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] }[];
    };
    expect(body.contents[0].parts).toEqual([{ text: 'earlier' }]);
    expect(body.contents[1].parts).toEqual([
      { text: 'transcribe this' },
      { inlineData: { mimeType: 'audio/webm', data: 'AAAA' } },
    ]);
  });

  it('leaves turns text-only when no audio is attached', () => {
    const body = buildGeminiBody({ system: 's', turns: [newTurn('user', 'hi')] }) as {
      contents: { parts: unknown[] }[];
    };
    expect(body.contents[0].parts).toEqual([{ text: 'hi' }]);
  });

  it('strips additionalProperties from the response schema at every depth (Gemini 400s on it)', () => {
    const body = buildGeminiBody({
      system: 's',
      turns: [newTurn('user', 'x')],
      responseSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['steps'],
        properties: {
          steps: {
            type: 'array',
            minItems: 1,
            items: { type: 'object', additionalProperties: false, properties: { tool: { type: 'string' } } },
          },
        },
      },
    }) as { generationConfig: { responseSchema: Record<string, unknown> } };
    const schema = body.generationConfig.responseSchema;
    expect(JSON.stringify(schema)).not.toContain('additionalProperties');
    // Supported fields survive
    expect(JSON.stringify(schema)).toContain('minItems');
    expect((schema.properties as Record<string, unknown>).steps).toBeDefined();
  });

  it('includes function declarations when tools are passed', () => {
    const body = buildGeminiBody({ system: 's', turns: [newTurn('user', 'x')], tools: [tool] }) as {
      tools: { functionDeclarations: { name: string }[] }[];
    };
    expect(body.tools[0].functionDeclarations[0].name).toBe('add_task');
  });

  it('adds the google_search grounding tool when webSearch is set', () => {
    const body = buildGeminiBody({ system: 's', turns: [newTurn('user', 'x')], webSearch: true }) as {
      tools: Record<string, unknown>[];
    };
    expect(body.tools).toContainEqual({ google_search: {} });
  });

  it('omits tools entirely when neither functions nor webSearch are given', () => {
    const body = buildGeminiBody({ system: 's', turns: [newTurn('user', 'x')] }) as {
      tools?: unknown;
    };
    expect(body.tools).toBeUndefined();
  });

  it('maps a tool turn to a functionResponse part keyed by name', () => {
    const body = buildGeminiBody({
      system: 's',
      turns: [
        newTurn('user', 'what did I highlight?'),
        newTurn('assistant', '', {
          toolUses: [{ id: 'g0', name: 'search_library', params: { query: 'attention' } }],
        }),
        newTurn('tool', '4 highlights', {
          toolResult: { id: 'g0', name: 'search_library', ok: true },
        }),
      ],
    }) as { contents: { role: string; parts: Record<string, unknown>[] }[] };

    expect(body.contents[1]).toEqual({
      role: 'model',
      parts: [{ functionCall: { name: 'search_library', args: { query: 'attention' } } }],
    });
    // Gemini pairs the response to the call by NAME, not by id
    expect(body.contents[2]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { name: 'search_library', response: { result: '4 highlights' } } }],
    });
  });
});

describe('parseGeminiResponse', () => {
  it('joins text parts', () => {
    const reply = parseGeminiResponse({
      candidates: [{ content: { parts: [{ text: 'Hello ' }, { text: 'world' }] } }],
    });
    expect(reply).toEqual({ text: 'Hello world' });
  });

  it('extracts function calls', () => {
    const reply = parseGeminiResponse({
      candidates: [
        { content: { parts: [{ functionCall: { name: 'add_task', args: { text: 'hi' } } }] } },
      ],
    });
    expect(reply.toolCalls).toEqual([
      { id: 'gemini-0', name: 'add_task', params: { text: 'hi' } },
    ]);
  });

  it('collects grounding chunks as web sources, deduped by url', () => {
    const reply = parseGeminiResponse({
      candidates: [
        {
          content: { parts: [{ text: 'Grounded.' }] },
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: 'https://a.example/x', title: 'A' } },
              { web: { uri: 'https://a.example/x', title: 'A again' } },
              { web: { uri: 'https://b.example/y' } },
            ],
          },
        },
      ],
    });
    expect(reply.sources).toEqual([
      { id: '', kind: 'web', title: 'A', url: 'https://a.example/x' },
      { id: '', kind: 'web', title: 'https://b.example/y', url: 'https://b.example/y' },
    ]);
  });

  it('omits sources entirely when the answer was not grounded', () => {
    const reply = parseGeminiResponse({
      candidates: [{ content: { parts: [{ text: 'hi' }] } }],
    });
    expect(reply.sources).toBeUndefined();
  });

  it('throws on empty candidates and surfaces block reasons', () => {
    expect(() => parseGeminiResponse({})).toThrow('no candidates');
    expect(() => parseGeminiResponse({ promptFeedback: { blockReason: 'SAFETY' } })).toThrow(
      'SAFETY',
    );
  });
});

describe('friendlyHttpError', () => {
  it('flags bad keys on 400/403', () => {
    expect(friendlyHttpError(403)).toContain('API key');
  });

  it('surfaces the API message on 429 (rate limit vs depleted credits)', () => {
    expect(
      friendlyHttpError(429, { error: { message: 'Your prepayment credits are depleted. ' } }),
    ).toBe('Your prepayment credits are depleted.');
  });

  it('falls back to a generic 429 message without a body', () => {
    expect(friendlyHttpError(429)).toContain('rate limit');
    expect(friendlyHttpError(429, 'not json')).toContain('rate limit');
  });

  it('marks 5xx as a temporary overload the user can retry', () => {
    expect(friendlyHttpError(503)).toBe(
      'Gemini is temporarily overloaded (HTTP 503) — try again in a moment.',
    );
    expect(friendlyHttpError(500, { error: { message: 'boom' } })).toContain(
      'temporarily overloaded',
    );
  });

  it('reports genuinely unknown statuses generically', () => {
    expect(friendlyHttpError(418)).toBe('Gemini request failed (HTTP 418).');
  });
});

describe('fetchWithRetry', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('retries a transient 503 and returns the eventual 200', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response('{"ok":1}', { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const waits: number[] = [];
    const res = await fetchWithRetry('https://gemini.test', '{}', undefined, {
      random: () => 0.5,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([400]);
  });

  it('does not retry a non-transient status and throws a friendly error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: { message: 'x' } }), { status: 403 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      fetchWithRetry('https://gemini.test', '{}', undefined, { sleep: async () => {} }),
    ).rejects.toThrow('API key');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after exhausting retries on a persistent 503', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      fetchWithRetry('https://gemini.test', '{}', undefined, { sleep: async () => {} }),
    ).rejects.toThrow('temporarily overloaded');
    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('honors Retry-After but caps it for an interactive request', async () => {
    const waits: number[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 503, headers: { 'Retry-After': '30' } }),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await fetchWithRetry('https://gemini.test', '{}', undefined, {
      random: () => 0.5,
      maxRetryAfterMs: 2500,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(waits).toEqual([2500]);
  });

  it('aborts during backoff instead of issuing another request', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const pending = fetchWithRetry('https://gemini.test', '{}', controller.signal, {
      backoffsMs: [10_000],
      random: () => 0.5,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('Gemini retry timing', () => {
  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfterMs('1.5', 0)).toBe(1500);
    expect(parseRetryAfterMs('Thu, 01 Jan 1970 00:00:03 GMT', 1000)).toBe(2000);
    expect(parseRetryAfterMs('junk', 0)).toBeNull();
  });

  it('adds deterministic jitter and never waits less than Retry-After', () => {
    const res = new Response(null, { status: 503, headers: { 'Retry-After': '1' } });
    expect(
      retryDelayMs(res, 0, {
        backoffsMs: [400],
        random: () => 0.5,
        maxRetryAfterMs: 3000,
      }),
    ).toBe(1000);
  });
});

describe('parseSseData', () => {
  it('pulls the text delta from a chunk', () => {
    const chunk = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'delta' }] } }] });
    expect(parseSseData(chunk)).toBe('delta');
  });

  it('returns empty for [DONE] and junk', () => {
    expect(parseSseData('[DONE]')).toBe('');
    expect(parseSseData('not json')).toBe('');
  });

  // Trimming each delta is what used to render "This slideexplains".
  it('keeps the whitespace that separates one delta from the next', () => {
    const chunk = (text: string) =>
      JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });
    const deltas = ['This slide', ' explains', ' KL divergence.'].map((t) => parseSseData(chunk(t)));
    expect(deltas.join('')).toBe('This slide explains KL divergence.');
  });
});

describe('buildGeminiBody images', () => {
  it('attaches image parts to the last turn, after the text', () => {
    const body = buildGeminiBody({
      system: 's',
      turns: [newTurn('user', 'a'), newTurn('user', 'what is on this slide?')],
      images: [
        { mimeType: 'image/jpeg', dataBase64: 'AAA' },
        { mimeType: 'image/png', dataBase64: 'BBB' },
      ],
    }) as { contents: { parts: { text?: string; inlineData?: { mimeType: string } }[] }[] };
    expect(body.contents[0].parts).toHaveLength(1);
    const last = body.contents[1].parts;
    expect(last[0].text).toBe('what is on this slide?');
    expect(last[1].inlineData?.mimeType).toBe('image/jpeg');
    expect(last[2].inlineData?.mimeType).toBe('image/png');
  });
});
