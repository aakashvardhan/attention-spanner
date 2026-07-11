import { MAX_DUMP_CHARS } from '../constants';

/**
 * Brain-dump structuring via Chrome's built-in Gemini Nano (Prompt API).
 * On-device only: nothing leaves the machine, no API key. Runs in extension
 * PAGES (popup/newtab/capture), never the service worker — the model download
 * requires user activation, and inference can outlive an MV3 worker.
 */

export { MAX_DUMP_CHARS };

export interface StructuredDump {
  bullets: string[];
  tasks: string[];
}

export type AiAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

const STRUCTURE_TIMEOUT_MS = 30_000;

const SYSTEM_PROMPT =
  'You organize messy brain dumps for a busy person. ' +
  'Given raw unstructured text, extract: (1) "bullets": 3-8 short bullet points ' +
  "summarizing the distinct thoughts, keeping the writer's wording where possible; " +
  '(2) "tasks": 0-6 concrete actionable to-dos stated or clearly implied by the text, ' +
  'each starting with a verb, under 12 words. Never invent tasks not grounded in the text. ' +
  'Respond with JSON only.';

const RESPONSE_SCHEMA = {
  type: 'object',
  required: ['bullets', 'tasks'],
  additionalProperties: false,
  properties: {
    bullets: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 200 } },
    tasks: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 100 } },
  },
};

function promptApi(): typeof LanguageModel | null {
  return typeof LanguageModel === 'undefined' ? null : LanguageModel;
}

export async function getAvailability(): Promise<AiAvailability> {
  const api = promptApi();
  if (!api) return 'unavailable';
  try {
    return (await api.availability()) as AiAvailability;
  } catch {
    return 'unavailable';
  }
}

/** Shared Nano session factory — also used by ignition.ts (different prompt) */
export async function createSession(
  systemPrompt: string,
  onDownloadProgress?: (fraction: number) => void,
) {
  const api = promptApi();
  if (!api) throw new Error('Prompt API not supported in this Chrome');

  const initialPrompts: [LanguageModelSystemMessage] = [
    { role: 'system', content: systemPrompt },
  ];
  const monitor = (m: CreateMonitor) => {
    m.addEventListener('downloadprogress', (e) => {
      onDownloadProgress?.((e as ProgressEvent).loaded);
    });
  };

  // Low temperature for faithful structuring; both params must be set together.
  // Retry without sampling params if the platform rejects them.
  try {
    const params = await api.params();
    return await api.create({
      initialPrompts,
      monitor,
      temperature: Math.min(0.3, params?.maxTemperature ?? 0.3),
      topK: Math.min(3, params?.maxTopK ?? 3),
    });
  } catch {
    return await api.create({ initialPrompts, monitor });
  }
}

/**
 * Pure parser, unit-tested: tolerates code fences, validates shape,
 * trims/dedupes entries, clamps counts. Throws on anything unusable.
 */
export function parseStructuredResult(raw: string): StructuredDump {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new Error('Model returned invalid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Model returned non-object JSON');
  }

  const clean = (value: unknown, max: number): string[] => {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const entry of value) {
      if (typeof entry !== 'string') continue;
      const trimmed = entry.replace(/^[-•*]\s*/, '').trim();
      if (trimmed && !out.includes(trimmed)) out.push(trimmed);
      if (out.length >= max) break;
    }
    return out;
  };

  const record = parsed as Record<string, unknown>;
  const bullets = clean(record.bullets, 8);
  const tasks = clean(record.tasks, 6);
  if (bullets.length === 0 && tasks.length === 0) {
    throw new Error('Model returned no usable content');
  }
  return { bullets, tasks };
}

export async function structureBrainDump(
  text: string,
  opts: { onDownloadProgress?: (fraction: number) => void } = {},
): Promise<StructuredDump> {
  const input = text.trim().slice(0, MAX_DUMP_CHARS);
  if (!input) throw new Error('Nothing to structure');

  const session = await createSession(SYSTEM_PROMPT, opts.onDownloadProgress);
  try {
    const raw = await session.prompt(input, {
      responseConstraint: RESPONSE_SCHEMA,
      signal: AbortSignal.timeout(STRUCTURE_TIMEOUT_MS),
    });
    return parseStructuredResult(raw);
  } finally {
    session.destroy();
  }
}
