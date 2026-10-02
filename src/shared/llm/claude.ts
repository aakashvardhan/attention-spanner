import { CLAUDE_MODELS } from '../constants';

/**
 * Cloud overflow for public content only — route.ts decides when; this just
 * runs the call. The SDK is imported on first use, so a profile that never
 * turns the cloud on never loads it.
 *
 * On ask, the document goes in its own cached block ahead of the question, so
 * a second question about the same paper reads the document from the prompt
 * cache instead of paying for it again. The TTL is an hour: people read between
 * questions, and a 5-minute entry would lapse and be re-written (1.25x) each
 * time. An outline is one call whose answer is saved in aiCache, so a cache
 * write there would never be read.
 */
export async function claudeStream(opts: {
  apiKey: string;
  model: string;
  system: string;
  document: string;
  prompt: string;
  signal?: AbortSignal;
  onText?: (text: string) => void;
}): Promise<string> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: opts.apiKey, dangerouslyAllowBrowser: true });
  const deep = opts.model === CLAUDE_MODELS.deep;

  let text = '';
  try {
    const stream = client.beta.messages.stream(
      {
        model: opts.model,
        max_tokens: 8000,
        system: opts.system,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: opts.document,
                ...(deep ? { cache_control: { type: 'ephemeral' as const, ttl: '1h' as const } } : {}),
              },
              { type: 'text', text: opts.prompt },
            ],
          },
        ],
        // Sonnet 5.5 only: a moderate effort for reading questions, and the
        // server-side fallback so a misfiring safety decline is retried rather
        // than surfaced. Haiku 4.5 takes neither.
        ...(deep
          ? {
              output_config: { effort: 'medium' as const },
              betas: ['server-side-fallback-2026-07-01'],
              fallbacks: 'default' as const,
            }
          : {}),
      },
      { signal: opts.signal },
    );
    stream.on('text', (delta) => {
      text += delta;
      opts.onText?.(text);
    });
    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') throw new Error('Claude declined to answer this.');
    return text;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error('Claude rejected the API key.');
    if (err instanceof Anthropic.RateLimitError) throw new Error('Claude is rate-limiting this key. Try again shortly.');
    if (err instanceof Anthropic.APIConnectionError) throw new Error('Could not reach Claude.');
    throw err;
  }
}
