/**
 * One yes/no question to Gemini: is this title on one of the user's topics?
 * Asked only when the keyword matcher missed and the user added a key. Only
 * the title and hostname are sent, never a URL or page text.
 */

// ponytail: the model name is the deleted client's (0c70025), unverified without a key.
export const GEMINI_MODEL = 'gemini-3.8-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

export function geminiTopicBody(topics: readonly string[], text: string): unknown {
  return {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text:
              `Topics: ${topics.join('; ')}\n` +
              `Item (title and site): ${text}\n` +
              'Is this item about any of the topics? Answer with JSON {"onTopic": true} or {"onTopic": false}.',
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: { onTopic: { type: 'BOOLEAN' } },
        required: ['onTopic'],
      },
    },
  };
}

interface GenerateResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
}

/** `{"onTopic": bool}` anywhere in the text (a string, or a generateContent response); else null. */
export function parseTopicAnswer(raw: unknown): boolean | null {
  const text =
    typeof raw === 'string'
      ? raw
      : ((raw as GenerateResponse | null)?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  const m = /"onTopic"\s*:\s*(true|false)/.exec(text);
  return m ? m[1] === 'true' : null;
}

/** Null on any failure: no key, HTTP error, abort, unreadable answer. Never throws. */
export async function askGeminiOnTopic(opts: {
  apiKey: string;
  topics: readonly string[];
  text: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}): Promise<boolean | null> {
  if (!opts.apiKey) return null;
  try {
    const res = await (opts.fetch ?? fetch)(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': opts.apiKey },
      body: JSON.stringify(geminiTopicBody(opts.topics, opts.text)),
      signal: opts.signal,
    });
    if (!res.ok) return null;
    return parseTopicAnswer(await res.json());
  } catch {
    return null;
  }
}
