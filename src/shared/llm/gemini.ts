/**
 * Gemini, for one job the others cannot do: a YouTube video whose transcript
 * the extension cannot read. Gemini watches the public video itself, by URL.
 * YouTube is a public source, and the user turned this on by adding a key.
 *
 * Interactions API over server-sent events, with plain fetch: one endpoint,
 * three event types, not worth an SDK.
 */

// ponytail: the docs' examples name both gemini-3.8-flash and gemini-3.6-flash;
// unverified without a key. Make it a setting if Google renames it again.
export const GEMINI_MODEL = 'gemini-3.8-flash';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions?alt=sse';

export function geminiVideoBody(opts: { videoUrl: string; system: string; prompt: string }) {
  return {
    model: GEMINI_MODEL,
    system_instruction: opts.system,
    input: [
      { type: 'text', text: opts.prompt },
      { type: 'video', uri: opts.videoUrl },
    ],
    stream: true,
  };
}

/** Complete `data:` events in `buffer`, and the unfinished tail to prepend to the next chunk. */
export function readSse(buffer: string): { events: unknown[]; rest: string } {
  const blocks = buffer.split(/\r?\n\r?\n/);
  const rest = blocks.pop() ?? '';
  const events: unknown[] = [];
  for (const block of blocks) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      // A sentinel such as [DONE]; nothing to read.
    }
  }
  return { events, rest };
}

interface GeminiEvent {
  event_type?: string;
  delta?: { type?: string; text?: string };
  error?: { message?: string };
}

export async function geminiVideoStream(opts: {
  apiKey: string;
  videoUrl: string;
  system: string;
  prompt: string;
  signal?: AbortSignal;
  onText?: (text: string) => void;
}): Promise<string> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': opts.apiKey },
      body: JSON.stringify(geminiVideoBody(opts)),
      signal: opts.signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new Error('Could not reach Gemini.');
  }
  if (!res.ok || !res.body) {
    const detail = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (res.status === 401 || res.status === 403) throw new Error('Gemini rejected the API key.');
    if (res.status === 429) throw new Error('Gemini is rate-limiting this key. Try again shortly.');
    throw new Error(detail?.error?.message ? `Gemini: ${detail.error.message}` : `Gemini answered ${res.status}.`);
  }

  let text = '';
  let buffer = '';
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const { events, rest } = readSse(buffer + value);
    buffer = rest;
    for (const event of events as GeminiEvent[]) {
      if (event.event_type === 'error') throw new Error(`Gemini: ${event.error?.message ?? 'the video could not be read.'}`);
      if (event.event_type === 'step.delta' && event.delta?.type === 'text' && event.delta.text) {
        text += event.delta.text;
        opts.onText?.(text);
      }
    }
  }
  return text;
}
