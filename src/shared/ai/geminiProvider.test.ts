import { describe, expect, it } from 'vitest';
import { newTurn } from './assistantTypes';
import {
  buildGeminiBody,
  friendlyHttpError,
  parseGeminiResponse,
  parseSseData,
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
    expect(reply.toolCalls).toEqual([{ name: 'add_task', params: { text: 'hi' } }]);
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

  it('reports other statuses generically', () => {
    expect(friendlyHttpError(500, { error: { message: 'boom' } })).toBe(
      'Gemini request failed (HTTP 500).',
    );
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
});
