import { describe, expect, it } from 'vitest';
import {
  attachImagesToLastMessage,
  buildAnthropicBody,
  friendlyAnthropicError,
  parseAnthropicResponse,
  sanitizeAnthropicSchema,
  shouldStream,
  toAnthropicMessages,
} from './anthropicProvider';
import { newTurn } from './assistantTypes';

describe('sanitizeAnthropicSchema', () => {
  it('strips unsupported constraints and forces additionalProperties:false on objects', () => {
    const cleaned = sanitizeAnthropicSchema({
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', maxLength: 50 },
        age: { type: 'number', minimum: 0, maximum: 120 },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 5 },
      },
    }) as {
      additionalProperties: boolean;
      properties: Record<string, Record<string, unknown>>;
    };
    expect(cleaned.additionalProperties).toBe(false);
    expect(cleaned.properties.name).toEqual({ type: 'string' });
    expect(cleaned.properties.age).toEqual({ type: 'number' });
    expect(cleaned.properties.tags).toEqual({ type: 'array', items: { type: 'string' } });
  });

  it('keeps enum and passes non-objects through', () => {
    expect(sanitizeAnthropicSchema({ type: 'string', enum: ['a', 'b'] })).toEqual({
      type: 'string',
      enum: ['a', 'b'],
    });
    expect(sanitizeAnthropicSchema('x')).toBe('x');
  });
});

describe('buildAnthropicBody', () => {
  it('caches the system prefix and maps turns to messages', () => {
    const body = buildAnthropicBody({ system: 'be brief', turns: [newTurn('user', 'hi')] }) as {
      model: string;
      system: { text: string; cache_control: unknown }[];
      messages: { role: string; content: string }[];
    };
    expect(body.model).toBe('claude-haiku-4-5');
    expect(body.system[0]).toEqual({
      type: 'text',
      text: 'be brief',
      cache_control: { type: 'ephemeral' },
    });
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('maps a responseSchema to a sanitized output_config.format', () => {
    const body = buildAnthropicBody({
      system: 's',
      turns: [newTurn('user', 'x')],
      responseSchema: { type: 'object', properties: { intent: { type: 'string', maxLength: 20 } } },
    }) as { output_config: { format: { type: string; schema: { additionalProperties: boolean } } } };
    expect(body.output_config.format.type).toBe('json_schema');
    expect(JSON.stringify(body.output_config.format.schema)).not.toContain('maxLength');
    expect(body.output_config.format.schema.additionalProperties).toBe(false);
  });
});

describe('shouldStream', () => {
  const turns = [newTurn('user', 'hi')];
  const onToken = () => {};

  it('streams a plain answer with a token callback', () => {
    expect(shouldStream({ system: 's', turns, onToken })).toBe(true);
  });

  it('does not stream without a token callback', () => {
    expect(shouldStream({ system: 's', turns })).toBe(false);
  });

  it('does not stream structured output', () => {
    expect(shouldStream({ system: 's', turns, onToken, responseSchema: {} })).toBe(false);
  });

  it('does not stream a tool-calling turn', () => {
    const tool = {
      name: 'show_plan',
      description: 'Show the plan',
      params: { type: 'object' as const, required: [], additionalProperties: false as const, properties: {} },
      summary: () => 'Show the plan',
      run: async () => 'ok',
    };
    expect(shouldStream({ system: 's', turns, onToken, tools: [tool] })).toBe(false);
  });
});

describe('toAnthropicMessages', () => {
  it('leaves ordinary chat turns as plain string content', () => {
    expect(toAnthropicMessages([newTurn('user', 'hi'), newTurn('assistant', 'hello')])).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('emits text + tool_use blocks for an assistant turn that requested calls', () => {
    const turn = newTurn('assistant', 'Looking that up.', {
      toolUses: [{ id: 'tu_1', name: 'search_library', params: { query: 'attention' } }],
    });
    expect(toAnthropicMessages([turn])).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Looking that up.' },
          { type: 'tool_use', id: 'tu_1', name: 'search_library', input: { query: 'attention' } },
        ],
      },
    ]);
  });

  it('omits the text block when the assistant turn was only a tool call', () => {
    const turn = newTurn('assistant', '', {
      toolUses: [{ id: 'tu_1', name: 'show_plan', params: {} }],
    });
    const [message] = toAnthropicMessages([turn]) as { content: unknown[] }[];
    expect(message.content).toEqual([
      { type: 'tool_use', id: 'tu_1', name: 'show_plan', input: {} },
    ]);
  });

  it('merges consecutive tool turns into ONE user message', () => {
    // The API pairs every tool_use block of an assistant turn with the results
    // in the single message that follows — one message per result would leave
    // the later calls unanswered.
    const turns = [
      newTurn('assistant', '', {
        toolUses: [
          { id: 'a', name: 'show_plan', params: {} },
          { id: 'b', name: 'loose_ends', params: {} },
        ],
      }),
      newTurn('tool', 'plan text', { toolResult: { id: 'a', name: 'show_plan', ok: true } }),
      newTurn('tool', 'it broke', { toolResult: { id: 'b', name: 'loose_ends', ok: false } }),
    ];
    const messages = toAnthropicMessages(turns);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'plan text' },
        { type: 'tool_result', tool_use_id: 'b', content: 'it broke', is_error: true },
      ],
    });
  });

  it('starts a new message when a user turn separates two tool turns', () => {
    const turns = [
      newTurn('tool', 'one', { toolResult: { id: 'a', name: 'x', ok: true } }),
      newTurn('user', 'and now?'),
      newTurn('tool', 'two', { toolResult: { id: 'b', name: 'y', ok: true } }),
    ];
    expect(toAnthropicMessages(turns)).toHaveLength(3);
  });
});

describe('buildAnthropicBody with tools', () => {
  it('keeps the cache breakpoint on the system block when tools are present', () => {
    const body = buildAnthropicBody({
      system: 'be brief',
      turns: [newTurn('user', 'hi')],
      tools: [
        {
          name: 'show_plan',
          description: 'Show the plan',
          params: { type: 'object', required: [], additionalProperties: false, properties: {} },
          summary: () => 'Show the plan',
          run: async () => 'ok',
        },
      ],
    }) as {
      system: { cache_control: unknown }[];
      tools: { name: string; input_schema: unknown; cache_control?: unknown }[];
    };
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    // Tools render ahead of system, so the single system breakpoint covers both
    expect(body.tools[0].cache_control).toBeUndefined();
    // input_schema is NOT sanitized — ordinary JSON Schema, unlike output_config
    expect(body.tools[0].input_schema).toEqual({
      type: 'object',
      required: [],
      additionalProperties: false,
      properties: {},
    });
  });
});

describe('image attachments', () => {
  const image = { mimeType: 'image/jpeg', dataBase64: 'aGVsbG8=' };

  it('promotes the last user string message to text + image blocks', () => {
    const body = buildAnthropicBody({
      system: 's',
      turns: [newTurn('user', 'what is on this slide?')],
      images: [image],
    }) as { messages: { role: string; content: unknown }[] };
    expect(body.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'what is on this slide?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'aGVsbG8=' } },
      ],
    });
  });

  it('appends the image to an existing content array without dropping blocks', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'keep me' }] as Record<string, unknown>[] },
    ];
    attachImagesToLastMessage(messages, [image]);
    expect(messages[0].content).toEqual([
      { type: 'text', text: 'keep me' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'aGVsbG8=' } },
    ]);
  });

  it('leaves messages untouched when there are no images', () => {
    const body = buildAnthropicBody({ system: 's', turns: [newTurn('user', 'hi')] }) as {
      messages: { role: string; content: unknown }[];
    };
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
});

describe('parseAnthropicResponse', () => {
  it('joins text blocks', () => {
    expect(
      parseAnthropicResponse({
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'world' },
        ],
      }),
    ).toEqual({ text: 'Hello world' });
  });

  it('throws on a safety refusal', () => {
    expect(() => parseAnthropicResponse({ stop_reason: 'refusal', content: [] })).toThrow('declined');
  });

  it('extracts tool_use blocks alongside text, carrying their ids', () => {
    const reply = parseAnthropicResponse({
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'tu_1', name: 'search_library', input: { query: 'attention' } },
      ],
    });
    expect(reply.text).toBe('Let me check.');
    expect(reply.toolCalls).toEqual([
      { id: 'tu_1', name: 'search_library', params: { query: 'attention' } },
    ]);
  });

  it('defaults missing tool input to an empty object and skips malformed blocks', () => {
    const reply = parseAnthropicResponse({
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'show_plan' },
        { type: 'tool_use', name: 'no_id' },
      ],
    });
    expect(reply.toolCalls).toEqual([{ id: 'tu_1', name: 'show_plan', params: {} }]);
  });

  it('omits toolCalls entirely on a plain text answer', () => {
    expect(parseAnthropicResponse({ content: [{ type: 'text', text: 'hi' }] })).toEqual({
      text: 'hi',
    });
  });
});

describe('friendlyAnthropicError', () => {
  it('flags bad keys, rate limits, and overload; else generic', () => {
    expect(friendlyAnthropicError(401)).toContain('key');
    expect(friendlyAnthropicError(429, { error: { message: 'slow down' } })).toBe('slow down');
    expect(friendlyAnthropicError(429)).toContain('rate limit');
    expect(friendlyAnthropicError(529)).toContain('overloaded');
    expect(friendlyAnthropicError(503)).toContain('overloaded');
    expect(friendlyAnthropicError(418)).toBe('Claude request failed (HTTP 418).');
  });
});
