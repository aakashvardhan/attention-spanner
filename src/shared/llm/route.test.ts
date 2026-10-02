import { describe, expect, it } from 'vitest';
import { CLAUDE_MODELS, LOCAL_CONTEXT_CHARS } from '../constants';
import { route, sourceForUrl, type AiSource, type AiTask, type RouteEnv } from './route';

const env: RouteEnv = {
  ollamaUp: true,
  hasLocalModel: true,
  online: true,
  cloudMode: 'public',
  hasKey: true,
};
const SHORT = 1_000;
const LONG = LOCAL_CONTEXT_CHARS + 1;

const PRIVATE: AiSource[] = ['web', 'localFile', 'annotation'];
const PUBLIC: AiSource[] = ['rss', 'arxiv', 'doi', 'youtube'];
const TASKS: AiTask[] = ['recap', 'triage', 'summarize', 'ask'];

describe('route — privacy is absolute', () => {
  // Every combination of environment, task and size: a private source must
  // never be routed to the cloud, however favourable the cloud settings are.
  it('never sends a private source to Claude, in any state', () => {
    for (const source of PRIVATE)
      for (const task of TASKS)
        for (const chars of [SHORT, LONG])
          for (const ollamaUp of [true, false])
            for (const online of [true, false]) {
              const r = route({ task, source, chars }, { ...env, ollamaUp, online });
              expect(r.target, `${source}/${task}/${chars}/${ollamaUp}/${online}`).not.toBe('claude');
            }
  });

  it('keeps a long private document local, via retrieval', () => {
    const r = route({ task: 'ask', source: 'localFile', chars: LONG }, env);
    expect(r).toMatchObject({ target: 'ollama', retrieval: true });
    expect(r.reason).toMatch(/stays on device/);
  });

  it('refuses rather than leaks when a private document has no local model', () => {
    const r = route({ task: 'ask', source: 'web', chars: SHORT }, { ...env, ollamaUp: false });
    expect(r).toEqual({ target: 'none', reason: 'Ollama is not running' });
  });
});

describe('route — local first', () => {
  it('runs anything that fits on device, public or not', () => {
    for (const source of [...PUBLIC, ...PRIVATE]) {
      expect(route({ task: 'ask', source, chars: SHORT }, env)).toMatchObject({
        target: 'ollama',
        retrieval: false,
      });
    }
  });

  it('never sends recap or triage to the cloud, even long and public', () => {
    for (const task of ['recap', 'triage'] as const) {
      expect(route({ task, source: 'arxiv', chars: LONG }, env).target).toBe('ollama');
      expect(route({ task, source: 'arxiv', chars: SHORT }, { ...env, ollamaUp: false }).target).toBe(
        'none',
      );
    }
  });

  it('says why when no model is picked', () => {
    expect(
      route({ task: 'recap', source: 'rss', chars: SHORT }, { ...env, hasLocalModel: false }),
    ).toEqual({ target: 'none', reason: 'No local model picked in Settings' });
  });
});

describe('route — public overflow', () => {
  it('sends a long public question to Sonnet and a long summary to Haiku', () => {
    expect(route({ task: 'ask', source: 'arxiv', chars: LONG }, env)).toMatchObject({
      target: 'claude',
      model: CLAUDE_MODELS.deep,
      confirm: false,
    });
    expect(route({ task: 'summarize', source: 'youtube', chars: LONG }, env)).toMatchObject({
      target: 'claude',
      model: CLAUDE_MODELS.quick,
    });
  });

  it('asks first in "ask" mode', () => {
    const r = route({ task: 'ask', source: 'doi', chars: LONG }, { ...env, cloudMode: 'ask' });
    expect(r).toMatchObject({ target: 'claude', confirm: true });
  });

  it('covers for a stopped Ollama with public content', () => {
    const r = route({ task: 'ask', source: 'rss', chars: SHORT }, { ...env, ollamaUp: false });
    expect(r).toMatchObject({ target: 'claude' });
    expect(r.reason).toMatch(/Ollama is not running/);
  });

  it('falls back to local retrieval when the cloud is off, keyless or offline', () => {
    for (const patch of [{ cloudMode: 'off' as const }, { hasKey: false }, { online: false }]) {
      expect(route({ task: 'ask', source: 'arxiv', chars: LONG }, { ...env, ...patch })).toMatchObject({
        target: 'ollama',
        retrieval: true,
      });
    }
  });

  it('has nothing to offer offline with Ollama down', () => {
    const r = route({ task: 'ask', source: 'arxiv', chars: LONG }, { ...env, online: false, ollamaUp: false });
    expect(r.target).toBe('none');
  });
});

describe('sourceForUrl', () => {
  it('treats only public-by-construction hosts as public sources', () => {
    expect(sourceForUrl('https://arxiv.org/pdf/2401.00001')).toBe('arxiv');
    expect(sourceForUrl('https://export.arxiv.org/abs/2401.00001')).toBe('arxiv');
    expect(sourceForUrl('https://doi.org/10.1000/xyz')).toBe('doi');
    expect(sourceForUrl('https://www.youtube.com/watch?v=abc')).toBe('youtube');
  });

  it('calls everything else private', () => {
    expect(sourceForUrl('file:///Users/me/contract.pdf')).toBe('localFile');
    expect(sourceForUrl('https://mail.google.com/mail/u/0')).toBe('web');
    // A look-alike host must not pass as arXiv.
    expect(sourceForUrl('https://arxiv.org.evil.example/paper.pdf')).toBe('web');
    expect(sourceForUrl('not a url')).toBe('web');
  });
});
