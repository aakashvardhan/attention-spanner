import { MAX_DUMP_CHARS } from '../constants';
import { getSettings } from '../storage';
import { newTurn } from './assistantTypes';
import { cloudProviderFor, hasCloudKey } from './cloud';

/**
 * Brain-dump structuring, on-device first: Chrome's built-in Gemini Nano
 * (Prompt API) when the browser has it, otherwise the cloud provider the user
 * configured in Settings → Assistant. Nano keeps the dump on the machine and
 * needs no key, so it always wins when present; the cloud path exists because
 * Chromium forks (Brave, Vivaldi) and older Chrome ship no Nano at all, which
 * previously left those browsers with raw notes only.
 *
 * Runs in extension PAGES (popup/newtab/capture), never the service worker —
 * the Nano model download requires user activation, and inference can outlive
 * an MV3 worker.
 */

export { MAX_DUMP_CHARS };

export interface StructuredDump {
  bullets: string[];
  tasks: string[];
}

export type AiAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

const STRUCTURE_TIMEOUT_MS = 30_000;
const NANO_TEXT_LANGUAGES: LanguageModelExpected[] = [
  { type: 'text', languages: ['en'] },
];

const SYSTEM_PROMPT =
  'You organize messy brain dumps for a busy person. ' +
  'Given raw unstructured text, extract: (1) "bullets": up to 3 short bullet points ' +
  "summarizing the distinct thoughts, keeping the writer's wording where possible; " +
  '(2) "tasks": exactly 1 possible starting action when one is grounded in the text, ' +
  'starting with a verb and under 12 words. Never invent work not grounded in the text. ' +
  'Respond with JSON only.';

const RESPONSE_SCHEMA = {
  type: 'object',
  required: ['bullets', 'tasks'],
  additionalProperties: false,
  properties: {
    bullets: { type: 'array', maxItems: 3, items: { type: 'string', maxLength: 200 } },
    tasks: { type: 'array', maxItems: 1, items: { type: 'string', maxLength: 100 } },
  },
};

function promptApi(): typeof LanguageModel | null {
  return typeof LanguageModel === 'undefined' ? null : LanguageModel;
}

export async function getAvailability(): Promise<AiAvailability> {
  const api = promptApi();
  if (!api) return 'unavailable';
  try {
    return (await api.availability({
      expectedInputs: NANO_TEXT_LANGUAGES,
      expectedOutputs: NANO_TEXT_LANGUAGES,
    })) as AiAvailability;
  } catch {
    return 'unavailable';
  }
}

/** What each engine can do right now: Nano's own availability, plus whether
 * the configured cloud provider has a key. */
export interface DumpEngines {
  nano: AiAvailability;
  cloud: boolean;
}

export async function getEngines(): Promise<DumpEngines> {
  const [nano, settings] = await Promise.all([getAvailability(), getSettings()]);
  return { nano, cloud: hasCloudKey(settings) };
}

/**
 * The degradation ladder, pure so the UI and structureBrainDump agree on it.
 * 'downloadable' picks Nano — the first create() kicks off the one-time
 * download. 'downloading' does not: the model isn't usable yet, so a
 * configured cloud key structures this dump instead of making the user wait.
 */
export function pickDumpEngine(engines: DumpEngines): 'nano' | 'cloud' | 'none' {
  if (engines.nano === 'available' || engines.nano === 'downloadable') return 'nano';
  return engines.cloud ? 'cloud' : 'none';
}

/** Shared Nano session factory — also used by ignition.ts and the assistant.
 * `history` seeds prior conversation turns after the system prompt. */
export async function createSession(
  systemPrompt: string,
  onDownloadProgress?: (fraction: number) => void,
  history: LanguageModelMessage[] = [],
) {
  const api = promptApi();
  if (!api) throw new Error('Prompt API not supported in this browser');

  const initialPrompts: [LanguageModelSystemMessage, ...LanguageModelMessage[]] = [
    { role: 'system', content: systemPrompt },
    ...history,
  ];
  const monitor = (m: CreateMonitor) => {
    m.addEventListener('downloadprogress', (e) => {
      onDownloadProgress?.((e as ProgressEvent).loaded);
    });
  };
  // Chrome warns (and may degrade output) without an explicit language declaration.
  // Low temperature for faithful structuring; both params must be set together.
  // Retry without sampling params if the platform rejects them.
  try {
    const params = await api.params();
    return await api.create({
      initialPrompts,
      monitor,
      expectedInputs: NANO_TEXT_LANGUAGES,
      expectedOutputs: NANO_TEXT_LANGUAGES,
      temperature: Math.min(0.3, params?.maxTemperature ?? 0.3),
      topK: Math.min(3, params?.maxTopK ?? 3),
    });
  } catch {
    return await api.create({
      initialPrompts,
      monitor,
      expectedInputs: NANO_TEXT_LANGUAGES,
      expectedOutputs: NANO_TEXT_LANGUAGES,
    });
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
  const bullets = clean(record.bullets, 3);
  const tasks = clean(record.tasks, 1);
  if (bullets.length === 0 && tasks.length === 0) {
    throw new Error('Model returned no usable content');
  }
  return { bullets, tasks };
}

async function structureWithNano(
  input: string,
  onDownloadProgress?: (fraction: number) => void,
): Promise<StructuredDump> {
  const session = await createSession(SYSTEM_PROMPT, onDownloadProgress);
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

async function structureWithCloud(input: string): Promise<StructuredDump> {
  const settings = await getSettings();
  const reply = await cloudProviderFor(settings).generate({
    system: SYSTEM_PROMPT,
    turns: [newTurn('user', input)],
    responseSchema: RESPONSE_SCHEMA,
    signal: AbortSignal.timeout(STRUCTURE_TIMEOUT_MS),
  });
  return parseStructuredResult(reply.text);
}

export async function structureBrainDump(
  text: string,
  opts: { onDownloadProgress?: (fraction: number) => void } = {},
): Promise<StructuredDump> {
  const input = text.trim().slice(0, MAX_DUMP_CHARS);
  if (!input) throw new Error('Nothing to structure');

  const engines = await getEngines();
  const engine = pickDumpEngine(engines);
  if (engine === 'none') {
    throw new Error(
      'No AI engine available — add a cloud API key in Settings → Assistant to structure dumps in this browser.',
    );
  }
  if (engine === 'nano') {
    try {
      return await structureWithNano(input, opts.onDownloadProgress);
    } catch (err) {
      // A key configured for the assistant is worth spending before giving up:
      // Nano can fail mid-download, refuse a session, or return unusable JSON.
      if (!engines.cloud) throw err;
    }
  }
  return structureWithCloud(input);
}
