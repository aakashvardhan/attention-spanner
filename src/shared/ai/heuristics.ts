import type { RoutedIntent } from './assistant';
import type { Tool } from './tools';

/**
 * Deterministic pre-router: skips the intent-classification LLM call for
 * high-traffic phrasings. Only picks intent/tool — param extraction and
 * confirm chips run unchanged afterwards, so a wrong match costs no more
 * than today's occasional misroute. Returns null whenever unsure.
 */

/** command-prefix → tool name (checked in order; first hit wins) */
const ACTION_RULES: Array<{ re: RegExp; tool: string }> = [
  { re: /^(?:add|create|new)\s+(?:a\s+|another\s+)?task\b/, tool: 'add_task' },
  { re: /^remember\b/, tool: 'remember' },
  { re: /^forget\b/, tool: 'forget' },
  { re: /^(?:start|begin)\s+(?:a\s+)?(?:focus|pomodoro)\b/, tool: 'start_focus' },
  { re: /^(?:stop|end)\s+(?:the\s+|my\s+)?(?:focus|pomodoro)\b/, tool: 'stop_focus' },
  { re: /^(?:start|begin)\s+(?:a\s+)?(?:reading\s+)?sprint\b/, tool: 'start_sprint' },
  { re: /^(?:log\s+(?:a\s+)?gym|gym\s+check[\s-]?in\b|i\s+went\s+to\s+the\s+gym\b)/, tool: 'gym_checkin' },
  { re: /^open\s+(?:the\s+|my\s+)?(?:dashboard|flashcards|papers|settings)\b/, tool: 'open_page' },
  { re: /^mark\s+all\s+(?:as\s+)?read\b/, tool: 'mark_all_read' },
  { re: /^refresh\s+(?:my\s+)?feeds?\b/, tool: 'refresh_feeds' },
];

/** question openers that always mean "answer from my data" */
const QUESTION_RE =
  /^(?:how\s+many|how\s+much|how\s+long|what's\s+my|what\s+is\s+my|whats\s+my|what\s+are\s+my|what\s+do\s+i|when\s+is|when's|do\s+i\s+have|did\s+i|have\s+i|am\s+i)\b/;

/** Chained commands need the multi-step planner's routing, not a single tool */
const CONNECTIVE_RE = /\b(?:and\s+then|then|and\s+also)\b|,\s*(?:and|then)\b/;

export function heuristicRoute(input: string, tools: readonly Tool[]): RoutedIntent | null {
  const text = input.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text) return null;

  if (QUESTION_RE.test(text)) return { intent: 'question', tool: null };

  if (CONNECTIVE_RE.test(text)) return null;
  for (const rule of ACTION_RULES) {
    if (rule.re.test(text) && tools.some((t) => t.name === rule.tool)) {
      return { intent: 'action', tool: rule.tool };
    }
  }
  return null;
}
