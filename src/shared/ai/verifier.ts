import { buildPlanSchema, parseJsonObject, parsePlan, type PlannedStep } from './assistant';
import { newTurn, type AssistantProvider } from './assistantTypes';
import type { Tool } from './tools';

/**
 * Sub-agent critic: a second model call reviews a proposed multi-step plan
 * against the user's data before the confirm chips are shown — one agent has
 * the idea, a different pass checks it. Only mutating plans of 2+ steps pay
 * for this, and any verifier failure falls through to the unverified plan;
 * verification can improve a plan but never block one.
 */

export interface CriticResult {
  verdict: 'ok' | 'revise';
  issues: string[];
  /** Corrected steps when the critic revised the plan (validated) */
  steps: PlannedStep[] | null;
}

export function buildCriticSystem(dataContext: string): string {
  return (
    "You verify a proposed action plan against the user's request and their data snapshot. " +
    'Flag steps that duplicate items that already exist, target things that do not exist, ' +
    'or do not match what the user asked for. Respond verdict "ok" when the plan is sound. ' +
    'Respond "revise" with corrected steps ONLY when a step is clearly wrong — never add ' +
    'steps the user did not ask for. Keep issues to one short sentence each.\n\n' +
    'Data snapshot:\n' +
    dataContext
  );
}

export function buildCriticSchema(tools: readonly Tool[]): object {
  const planSchema = buildPlanSchema(tools) as {
    properties: { steps: object };
  };
  return {
    type: 'object',
    required: ['verdict', 'issues'],
    additionalProperties: false,
    properties: {
      verdict: { type: 'string', enum: ['ok', 'revise'] },
      issues: { type: 'array', items: { type: 'string' } },
      steps: planSchema.properties.steps,
    },
  };
}

/** Parse a critic reply; throws on junk (callers treat that as "verifier failed") */
export function parseCriticReply(raw: string, tools: readonly Tool[]): CriticResult {
  const obj = parseJsonObject(raw);
  const verdict = obj.verdict === 'revise' ? 'revise' : 'ok';
  const issues = (Array.isArray(obj.issues) ? obj.issues : [])
    .filter((i): i is string => typeof i === 'string' && i.trim() !== '')
    .slice(0, 5);
  let steps: PlannedStep[] | null = null;
  if (verdict === 'revise' && Array.isArray(obj.steps) && obj.steps.length > 0) {
    // Reuse the plan validator — a revised plan gets no laxer treatment
    steps = parsePlan(JSON.stringify({ steps: obj.steps }), tools);
  }
  return { verdict, issues, steps };
}

/**
 * Run the critic pass. Never throws: { steps: null, issues: [] } means
 * "keep the original plan, nothing to flag".
 */
export async function verifyPlan(
  request: string,
  steps: PlannedStep[],
  tools: readonly Tool[],
  cloud: AssistantProvider,
  getContext: () => Promise<string>,
): Promise<{ steps: PlannedStep[] | null; issues: string[] }> {
  try {
    const context = await getContext();
    const plan = JSON.stringify({
      steps: steps.map((s) => ({ tool: s.name, params: s.params })),
    });
    const reply = await cloud.generate({
      system: buildCriticSystem(context),
      turns: [newTurn('user', `Request: ${request}\n\nProposed plan:\n${plan}`)],
      responseSchema: buildCriticSchema(tools),
    });
    const critic = parseCriticReply(reply.text, tools);
    if (critic.verdict === 'ok') return { steps: null, issues: [] };
    return { steps: critic.steps, issues: critic.issues };
  } catch {
    return { steps: null, issues: [] };
  }
}
