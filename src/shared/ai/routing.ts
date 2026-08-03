import type { Settings } from '../types';
import { anthropicProvider } from './anthropicProvider';
import type { AssistantProvider } from './assistantTypes';
import { geminiProvider } from './geminiProvider';

/**
 * Which model runs which kind of call. One table, consulted by role rather than
 * by provider name, so a routing decision is written down in exactly one place
 * and callers never hardcode "use Gemini here".
 *
 * Every role resolves to an ordered CHAIN, not a single provider: the head is
 * the preference, the tail is what to fall back to when a key is missing or a
 * call fails. That is also how the ReAct loop escalates on a stall — it walks
 * one step down the chain it was handed rather than re-deciding.
 *
 * `settings.cloudProvider` no longer selects the cloud outright. It orders the
 * last-resort fallback for a role whose own tier yielded nothing — it does not
 * reorder a tier, because the tier IS the routing decision. Nothing here
 * changes cloud.ts, whose eight other callers keep the single-provider meaning.
 */

export type ProviderId = AssistantProvider['id'];

export type ModelRole =
  /** Intent enum — tiny, cheap, latency-sensitive */
  | 'classify'
  /** One tool's params */
  | 'extract'
  /** The ReAct driver; needs native function calling */
  | 'loop'
  /** Decomposing a request into steps */
  | 'plan'
  /** Verifying a plan or refining an answer */
  | 'critic'
  /** Images — Gemini leads; Claude Haiku is the multimodal fallback */
  | 'vision'
  /** Long free-form answers */
  | 'chat';

/**
 * Providers that run on the user's own machine. Nano is Chrome's built-in;
 * Membership here means "costs nothing and sends nothing", which is what
 * cloudFor() is really asking about.
 */
const LOCAL_PROVIDER_IDS = new Set<ProviderId>(['nano']);

const TIERS: Record<ModelRole, readonly ProviderId[]> = {
  classify: ['nano', 'gemini'],
  extract: ['nano', 'gemini', 'anthropic'],
  loop: ['gemini', 'anthropic', 'nano'],
  plan: ['anthropic', 'gemini'],
  critic: ['anthropic', 'gemini'],
  vision: ['gemini', 'anthropic'],
  chat: ['gemini', 'anthropic'],
};

/** Last-resort order when a role's own tier yields nothing available */
const ANY_ORDER: readonly ProviderId[] = ['gemini', 'anthropic', 'nano'];

export interface RoutingEnv {
  providers: Partial<Record<ProviderId, AssistantProvider>>;
  available: Record<ProviderId, boolean>;
  /** settings.cloudProvider — moves the preferred cloud to the front of its tier */
  preferred: 'gemini' | 'anthropic';
}

/**
 * Ordered fallback chain for a role (pure). An empty result means the role
 * cannot run at all: 'vision' with no Gemini has no substitute, and a 'loop'
 * whose head is nano means the caller must use the non-looping JSON path.
 */
export function providerChain(role: ModelRole, env: RoutingEnv): AssistantProvider[] {
  const resolve = (ids: readonly ProviderId[]): AssistantProvider[] =>
    ids.filter((id) => env.available[id]).flatMap((id) => env.providers[id] ?? []);

  // The tier table is authoritative and `preferred` does NOT reorder it. Letting
  // it would defeat the point: the default preference is Gemini, so 'plan' and
  // 'critic' would stop reaching for Claude for exactly the users who configured
  // both keys. A user who wants only one cloud supplies only that key.
  const chain = resolve(TIERS[role]);
  if (chain.length > 0) return chain;

  // Vision has no text substitute — the caller degrades to answering without
  // the image rather than sending it somewhere that cannot read it.
  if (role === 'vision') return [];

  // Last resort: the role's own tier had nothing available. Here the user's
  // preference is the only signal there is, so it leads.
  const fallback = [
    env.preferred,
    ...ANY_ORDER.filter((id) => id !== env.preferred),
  ] as readonly ProviderId[];
  return resolve(fallback);
}

export interface ResolveRoutingDeps {
  nano: AssistantProvider;
  /** The single cloud a caller already chose; used to honor a passed-in probe */
  cloud?: AssistantProvider;
  /** Pre-probed availability — supplying this performs ZERO probes */
  availability?: {
    nano: boolean;
    cloud: boolean;
    gemini?: boolean;
    anthropic?: boolean;
  };
  preferred?: Settings['cloudProvider'];
}

/**
 * Gather the providers and their availability.
 *
 * Deliberately not memoized at module scope: `available()` is a settings read,
 * and a cached "no cloud" would survive the user pasting a key. Callers resolve
 * once per turn and reuse the result within it.
 */
export async function resolveRoutingEnv(deps: ResolveRoutingDeps): Promise<RoutingEnv> {
  const providers: Partial<Record<ProviderId, AssistantProvider>> = {
    nano: deps.nano,
    gemini: geminiProvider,
    anthropic: anthropicProvider,
  };
  // A caller-supplied cloud wins for its own id — it may be a test double, or a
  // provider the caller configured differently from the module singleton.
  if (deps.cloud) providers[deps.cloud.id] = deps.cloud;

  const preferred = deps.preferred ?? 'gemini';

  if (deps.availability) {
    const { nano, cloud, gemini, anthropic } = deps.availability;
    // The wake path memoizes a single {nano, cloud} pair. Honor it verbatim:
    // `cloud` describes deps.cloud, and the cloud it did NOT probe is unknown,
    // so treat it as unavailable rather than spending a round trip to find out.
    const cloudId = deps.cloud?.id;
    return {
      providers,
      available: {
        nano,
        gemini: gemini ?? (cloudId === 'gemini' ? cloud : false),
        anthropic: anthropic ?? (cloudId === 'anthropic' ? cloud : false),
        // Unprobed means unknown, and unknown means unavailable here — the
        // same rule the two clouds follow. A caller that memoized only
        // {nano, cloud} must not accidentally enlist a local server it never
        // checked, which on a dead port would stall the turn.
      },
      preferred,
    };
  }

  // A provider whose own availability check throws (unreachable storage, a
  // wedged Nano runtime) is not usable, and must not take the whole turn down
  // with it — the other providers are still fine.
  const probe = async (p: AssistantProvider | undefined): Promise<boolean> => {
    if (!p) return false;
    try {
      return await p.available();
    } catch {
      return false;
    }
  };
  const [nano, gemini, anthropic] = await Promise.all([
    probe(providers.nano),
    probe(providers.gemini),
    probe(providers.anthropic),
  ]);
  return { providers, available: { nano, gemini, anthropic }, preferred };
}

/**
 * The best cloud provider for a role, or undefined when no cloud can serve it.
 *
 * Asks LOCAL_PROVIDER_IDS rather than `id !== 'nano'`: callers use this to
 * escalate *off* the local path (assistant.ts, once input passes the Nano
 * budget), and handing back another local model would not be an escalation.
 */
export function cloudFor(role: ModelRole, env: RoutingEnv): AssistantProvider | undefined {
  return providerChain(role, env).find((p) => !LOCAL_PROVIDER_IDS.has(p.id));
}
