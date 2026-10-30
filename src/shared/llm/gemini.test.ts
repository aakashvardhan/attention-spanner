import { describe, expect, it } from 'vitest';
import { geminiVideoBody, readSse } from './gemini';

describe('readSse', () => {
  it('reads data events, holds back a partial one, and tolerates event: lines and CRLF', () => {
    const { events, rest } = readSse(
      'event: step.delta\r\ndata: {"event_type":"step.delta","index":0,"delta":{"type":"text","text":"Hi"}}\r\n\r\n' +
        'data: {"event_type":"interaction.completed"}\n\n' +
        'data: {"event_type":"step.de',
    );
    expect(events).toEqual([
      { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'Hi' } },
      { event_type: 'interaction.completed' },
    ]);
    expect(rest).toBe('data: {"event_type":"step.de');
  });

  it('skips keep-alive comments and non-JSON data', () => {
    expect(readSse(': ping\n\ndata: [DONE]\n\n').events).toEqual([]);
  });
});

describe('geminiVideoBody', () => {
  it('asks a streamed question about the video by its URL, with the system instruction', () => {
    const body = geminiVideoBody({ videoUrl: 'https://www.youtube.com/watch?v=2pWv7GOvuf0', system: 'Be brief.', prompt: 'Summarize.' });
    expect(body).toMatchObject({
      stream: true,
      system_instruction: 'Be brief.',
      input: [
        { type: 'text', text: 'Summarize.' },
        { type: 'video', uri: 'https://www.youtube.com/watch?v=2pWv7GOvuf0' },
      ],
    });
    expect(typeof body.model).toBe('string');
  });
});
