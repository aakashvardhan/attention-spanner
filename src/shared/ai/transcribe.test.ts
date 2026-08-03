import { describe, expect, it } from 'vitest';
import {
  buildSummarySystem,
  buildTranscribePrompt,
  cleanTranscript,
  parseSummaryResult,
} from './transcribe';
import { PRIOR_TAIL_CHARS } from '../recordings';

describe('buildSummarySystem', () => {
  it('leads a meeting with decisions and commitments', () => {
    const system = buildSummarySystem('meeting');
    expect(system).toContain('MEETING');
    expect(system).toContain('decisions');
    expect(system).toContain('committed');
  });

  it('leads a lecture with concepts and exam signals', () => {
    const system = buildSummarySystem('lecture');
    expect(system).toContain('LECTURE');
    expect(system).toContain('concepts');
    expect(system).toContain('examined');
    // Lectures without homework must yield an empty list, not invented tasks
    expect(system).toContain('empty list is correct');
  });

  it('defaults to the generic video lead', () => {
    expect(buildSummarySystem()).toBe(buildSummarySystem('video'));
    expect(buildSummarySystem()).toContain('one-line takeaway');
  });

  it('keeps the shared skeleton in every variant', () => {
    for (const purpose of ['meeting', 'lecture', 'video'] as const) {
      const system = buildSummarySystem(purpose);
      expect(system).toContain('Respond with JSON only');
      expect(system).toContain('"actionItems"');
      expect(system).toContain('no emoji');
      expect(system).toContain('LaTeX');
    }
  });
});

describe('buildTranscribePrompt', () => {
  it('asks plainly when there is no prior context', () => {
    expect(buildTranscribePrompt('')).toBe('Transcribe this audio.');
    expect(buildTranscribePrompt('   ')).toBe('Transcribe this audio.');
  });

  it('carries the previous tail and forbids repeating it', () => {
    const prompt = buildTranscribePrompt('the chain rule gives us');
    expect(prompt).toContain('the chain rule gives us');
    expect(prompt).toContain('Do not repeat that text');
  });

  it('caps the carried context', () => {
    const prompt = buildTranscribePrompt('x'.repeat(PRIOR_TAIL_CHARS * 3));
    expect(prompt).not.toContain('x'.repeat(PRIOR_TAIL_CHARS + 1));
  });
});

describe('cleanTranscript', () => {
  it('returns plain speech untouched', () => {
    expect(cleanTranscript('Backpropagation uses the chain rule.')).toBe(
      'Backpropagation uses the chain rule.',
    );
  });

  it('strips markdown fences', () => {
    expect(cleanTranscript('```\nhello there\n```')).toBe('hello there');
    expect(cleanTranscript('```text\nhello there\n```')).toBe('hello there');
  });

  it('strips a conversational preamble', () => {
    expect(cleanTranscript('Here is the transcript: hello there')).toBe('hello there');
    expect(cleanTranscript('Transcript: hello there')).toBe('hello there');
  });

  it('collapses a silent segment to empty rather than narrating the silence', () => {
    // Otherwise "No speech detected." lands in the middle of a lecture transcript
    expect(cleanTranscript('No speech detected.')).toBe('');
    expect(cleanTranscript('[silence]')).toBe('');
    expect(cleanTranscript('The audio contains no speech.')).toBe('');
  });

  it('keeps inaudible markers inside real speech', () => {
    expect(cleanTranscript('the gradient [inaudible] converges')).toBe(
      'the gradient [inaudible] converges',
    );
  });

  it('strips emoji', () => {
    expect(cleanTranscript('great work 🎉 everyone')).toBe('great work everyone');
  });
});

describe('parseSummaryResult', () => {
  it('parses summary and action items', () => {
    const out = parseSummaryResult(
      JSON.stringify({
        summary: '## Takeaway\n- gradients flow backward',
        actionItems: ['Read chapter 4', 'Email Professor Chen'],
      }),
    );
    expect(out.summary).toBe('## Takeaway\n- gradients flow backward');
    expect(out.actionItems).toEqual(['Read chapter 4', 'Email Professor Chen']);
  });

  it('parses JSON wrapped in a fence', () => {
    const out = parseSummaryResult('```json\n{"summary":"s","actionItems":[]}\n```');
    expect(out.summary).toBe('s');
  });

  it('strips bullet prefixes and deduplicates action items', () => {
    const out = parseSummaryResult(
      JSON.stringify({ summary: '', actionItems: ['- Read ch 4', 'Read ch 4', '• Submit lab'] }),
    );
    expect(out.actionItems).toEqual(['Read ch 4', 'Submit lab']);
  });

  it('caps action items at ten', () => {
    const many = Array.from({ length: 20 }, (_, i) => `Task ${i}`);
    expect(parseSummaryResult(JSON.stringify({ summary: '', actionItems: many })).actionItems)
      .toHaveLength(10);
  });

  it('skips non-string entries instead of failing', () => {
    const out = parseSummaryResult(
      JSON.stringify({ summary: 's', actionItems: [null, 42, 'Real task'] }),
    );
    expect(out.actionItems).toEqual(['Real task']);
  });

  it('tolerates missing fields', () => {
    expect(parseSummaryResult('{}')).toEqual({ summary: '', actionItems: [] });
  });

  it('throws on invalid JSON', () => {
    expect(() => parseSummaryResult('not json')).toThrow('invalid JSON');
  });

  it('throws on non-object JSON', () => {
    expect(() => parseSummaryResult('[1,2]')).toThrow('non-object');
  });
});

describe('buildTranscribePrompt context', () => {
  it('names the purpose and title as a vocabulary hint', () => {
    const prompt = buildTranscribePrompt('', 'CS231n: Convolutional Networks', 'lecture');
    expect(prompt).toContain('lecture');
    expect(prompt).toContain('CS231n: Convolutional Networks');
    expect(prompt).toContain('technical terms');
  });

  it('keeps the continuation instruction alongside the context', () => {
    const prompt = buildTranscribePrompt('the loss surface', 'Standup', 'meeting');
    expect(prompt).toContain('the loss surface');
    expect(prompt).toContain('Do not repeat that text.');
    expect(prompt).toContain('meeting');
  });

  it('is unchanged in shape without context', () => {
    expect(buildTranscribePrompt('')).toBe('Transcribe this audio.');
  });
});

describe('buildSummarySystem grounding', () => {
  it('demands [mm:ss] citations and forbids outside facts', () => {
    const system = buildSummarySystem('meeting');
    expect(system).toContain('[mm:ss]');
    expect(system).toContain('no facts from outside it');
    expect(system).toContain('[Visual mm:ss]');
  });
});
