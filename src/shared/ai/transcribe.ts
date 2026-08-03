import { getSettings } from '../storage';
import { PRIOR_TAIL_CHARS, type RecordingPurpose } from '../recordings';
import { newTurn } from './assistantTypes';
import { cloudProviderFor } from './cloud';
import { geminiProvider } from './geminiProvider';
import { stripEmoji } from './tts';

/**
 * Speech → text → summary, for recorded lectures and meetings.
 *
 * Transcription always resolves to Gemini, ignoring the user's `cloudProvider`
 * choice: Nano has no multimodal input and Claude accepts no audio, so Gemini
 * is not a preference here but the only option. Summarizing is plain text, so
 * that half honors the setting like every other feature does.
 *
 * Runs in the offscreen document, which is where the audio already lives —
 * shipping megabytes of base64 to another context to make the same call would
 * be pure overhead, and geminiProvider.ts keeps inference out of the worker.
 */

/** A 5-minute segment is a real upload plus real inference — be patient. */
const TRANSCRIBE_TIMEOUT_MS = 180_000;
const SUMMARY_TIMEOUT_MS = 90_000;

/**
 * Cap on transcript text sent to the summarizer. A 3-hour lecture day overruns
 * any context window worth paying for; the tail is dropped rather than the head
 * because summaries lean on what was set up early.
 */
export const TRANSCRIPT_SUMMARY_MAX_CHARS = 120_000;

const TRANSCRIBE_SYSTEM =
  'You are a transcription engine. Transcribe the audio verbatim into plain text. ' +
  'Preserve technical terms, proper nouns and numbers exactly. Add sentence punctuation ' +
  'and paragraph breaks where the speaker pauses. When more than one voice is clearly ' +
  'distinguishable, prefix their lines with "Speaker 1:", "Speaker 2:" and so on. ' +
  'Mark genuinely unintelligible audio as [inaudible]. Output ONLY the transcript — ' +
  'no preamble, no commentary, no markdown fences, no emoji. If the audio contains no ' +
  'speech at all, output nothing.';

/**
 * The purpose-specific half of the summary prompt: what the summary should
 * LEAD with, and what counts as an action item. A meeting and a lecture are
 * different documents wearing the same transcript shape — the reader of one
 * needs "what did we decide", the reader of the other "what must I understand".
 */
const SUMMARY_LEADS: Record<RecordingPurpose, string> = {
  meeting:
    'This is a MEETING transcript. Lead with the decisions that were made and who ' +
    'committed to what; then unresolved or open questions; then any other context worth ' +
    'keeping. "actionItems" are the commitments and to-dos people actually stated, ' +
    'attributed by name when the transcript names the speaker.',
  lecture:
    'This is a CLASS LECTURE transcript. Lead with the core concepts and definitions, ' +
    'stated precisely (mathematics as LaTeX); then how the ideas connect; then flag ' +
    'points the instructor emphasized, repeated, or hinted would be examined. ' +
    '"actionItems" are ONLY homework, reading, or deadlines actually announced — an ' +
    'empty list is correct when nothing was assigned.',
  video:
    'This is a video transcript. Lead with a one-line takeaway, then the key points. ' +
    '"actionItems" are concrete to-dos the video asks of the viewer, if any.',
};

/** Shared skeleton + per-purpose lead. Pure — unit-tested. No purpose = video/generic. */
export function buildSummarySystem(purpose?: RecordingPurpose): string {
  return (
    'You summarize transcripts for someone with ADHD who needs to find the substance ' +
    'fast. ' +
    SUMMARY_LEADS[purpose ?? 'video'] +
    ' The transcript lines are prefixed with [mm:ss] timestamps; lines marked ' +
    '[Visual mm:ss] describe what was on screen at that moment. Produce (1) ' +
    '"summary": Markdown grouped under a few short "## " section labels, ' +
    'using "- " bullets and **bold** for key terms; write any mathematics as LaTeX ' +
    '($…$ inline, $$…$$ displayed). End every bullet with the [mm:ss] timestamp of ' +
    'the passage that supports it, so each claim can be checked against the ' +
    'transcript. Use only what the transcript says — no facts from outside it — and ' +
    'keep its own wording for technical terms rather than correcting them; the ' +
    'transcription may have mis-heard a term, and a reader can only catch that if ' +
    'you preserve it. (2) "actionItems": 0-10 items, each starting with ' +
    'a verb and under 15 words. Never invent an action item that is not grounded in ' +
    'the text. Be blunt and concrete: no greetings, no filler, no exclamation marks, ' +
    'no emoji. Respond with JSON only.'
  );
}

const SUMMARY_SCHEMA = {
  type: 'object',
  required: ['summary', 'actionItems'],
  additionalProperties: false,
  properties: {
    summary: { type: 'string', maxLength: 6000 },
    actionItems: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 160 } },
  },
};

export interface TranscriptSummary {
  summary: string;
  actionItems: string[];
}

/**
 * The instruction for one segment. `priorTail` is the end of the previous
 * segment: rotation cuts the audio on a timer, not at a sentence, so without it
 * the model reliably restarts mid-thought and capitalizes a fragment as if it
 * were a new sentence. `title`/`purpose` bias the spelling of technical terms —
 * a mis-heard term here becomes a confidently wrong answer three steps
 * downstream, so the transcriber gets every hint the recording already has. Pure.
 */
export function buildTranscribePrompt(
  priorTail: string,
  title = '',
  purpose?: RecordingPurpose,
): string {
  const parts: string[] = [];
  const cleanTitle = title.trim();
  if (cleanTitle || purpose) {
    const what = purpose ?? 'recording';
    parts.push(
      `This is a ${what}${cleanTitle ? ` titled “${cleanTitle}”` : ''} — prefer spellings of ` +
        'technical terms and proper nouns consistent with that context.',
    );
  }
  const tail = priorTail.trim().slice(-PRIOR_TAIL_CHARS);
  if (!tail) {
    parts.push('Transcribe this audio.');
    return parts.join('\n\n');
  }
  parts.push(
    'This audio continues a recording already in progress. For context only, the ' +
      `transcript so far ended with:\n\n"…${tail}"\n\n` +
      'Do not repeat that text. Transcribe only what is spoken in this audio, ' +
      'continuing the sentence if it was cut mid-way.',
  );
  return parts.join('\n\n');
}

/**
 * Strip the wrappers models add despite being told not to. Pure. A model that
 * hears silence tends to say so in a sentence rather than return nothing, which
 * would otherwise land "No speech detected." in the middle of a transcript.
 */
export function cleanTranscript(raw: string): string {
  let text = raw
    .trim()
    .replace(/^```(?:\w+)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  text = text.replace(/^(?:here(?:'s| is) the (?:verbatim )?transcript[:.]?|transcript[:.])\s*/i, '');

  const silence =
    /^(?:\[?(?:no speech|silence|inaudible|no audible speech)[^\n]*\]?|the audio contains no speech[^\n]*)$/i;
  if (silence.test(text.trim())) return '';

  return stripEmoji(text.trim());
}

/** Transcribe one audio segment. Returns '' when the segment held no speech. */
export async function transcribeSegment(opts: {
  dataBase64: string;
  mimeType: string;
  /** Tail of the previous segment, for continuity across a rotation boundary */
  priorTail?: string;
  /** Recording title/purpose — vocabulary hints for technical terms */
  title?: string;
  purpose?: RecordingPurpose;
  signal?: AbortSignal;
}): Promise<string> {
  const reply = await geminiProvider.generate({
    system: TRANSCRIBE_SYSTEM,
    turns: [newTurn('user', buildTranscribePrompt(opts.priorTail ?? '', opts.title, opts.purpose))],
    audio: { mimeType: opts.mimeType, dataBase64: opts.dataBase64 },
    signal: opts.signal ?? AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
  });
  return cleanTranscript(reply.text);
}

/** Parse the summarizer's JSON. Pure — mirrors brainDump.parseStructuredResult. */
export function parseSummaryResult(raw: string): TranscriptSummary {
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
  // Arrays are typeof 'object' too — let one through and the caller gets a
  // silently empty summary instead of a visible failure.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Model returned non-object JSON');
  }

  const { summary, actionItems } = parsed as { summary?: unknown; actionItems?: unknown };

  const items: string[] = [];
  if (Array.isArray(actionItems)) {
    for (const entry of actionItems) {
      if (typeof entry !== 'string') continue;
      const trimmed = stripEmoji(entry.replace(/^[-•*]\s*/, '').trim());
      if (trimmed && !items.includes(trimmed)) items.push(trimmed);
      if (items.length >= 10) break;
    }
  }

  return {
    summary: typeof summary === 'string' ? stripEmoji(summary.trim()) : '',
    actionItems: items,
  };
}

/** Summarize a finished transcript through the user's configured cloud provider. */
export async function summarizeTranscript(
  title: string,
  transcript: string,
  purpose?: RecordingPurpose,
): Promise<TranscriptSummary> {
  const text = transcript.trim().slice(0, TRANSCRIPT_SUMMARY_MAX_CHARS);
  if (!text) return { summary: '', actionItems: [] };

  const settings = await getSettings();
  const reply = await cloudProviderFor(settings).generate({
    system: buildSummarySystem(purpose),
    turns: [newTurn('user', `Transcript of “${title}”:\n\n${text}`)],
    responseSchema: SUMMARY_SCHEMA,
    signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
  });
  return parseSummaryResult(reply.text);
}
