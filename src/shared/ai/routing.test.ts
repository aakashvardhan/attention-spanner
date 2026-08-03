import { describe, expect, it, vi } from 'vitest';
import type { AssistantProvider, ProviderReply } from './assistantTypes';
import {
  cloudFor,
  providerChain,
  resolveRoutingEnv,
  type ProviderId,
  type RoutingEnv,
} from './routing';

function fake(id: ProviderId, available = true): AssistantProvider {
  return {
    id,
    available: vi.fn(async () => available),
    generate: async (): Promise<ProviderReply> => ({ text: '' }),
  };
}

const nano = fake('nano');
const gemini = fake('gemini');
const anthropic = fake('anthropic');
const ollama = fake('ollama');

function env(
  available: Partial<Record<ProviderId, boolean>>,
  preferred: 'gemini' | 'anthropic' = 'gemini',
): RoutingEnv {
  return {
    providers: { nano, gemini, anthropic, ollama },
    available: {
      nano: available.nano ?? false,
      gemini: available.gemini ?? false,
      anthropic: available.anthropic ?? false,
      ollama: available.ollama ?? false,
    },
    preferred,
  };
}

const ids = (chain: AssistantProvider[]) => chain.map((p) => p.id);

describe('providerChain', () => {
  it('follows the tier table when everything is available', () => {
    const all = env({ nano: true, gemini: true, anthropic: true });
    expect(ids(providerChain('classify', all))).toEqual(['nano', 'gemini']);
    expect(ids(providerChain('extract', all))).toEqual(['nano', 'gemini', 'anthropic']);
    expect(ids(providerChain('loop', all))).toEqual(['gemini', 'anthropic', 'nano']);
    expect(ids(providerChain('plan', all))).toEqual(['anthropic', 'gemini']);
    expect(ids(providerChain('critic', all))).toEqual(['anthropic', 'gemini']);
    expect(ids(providerChain('vision', all))).toEqual(['gemini', 'anthropic']);
    expect(ids(providerChain('chat', all))).toEqual(['gemini', 'anthropic']);
  });

  it('gemini-only + nano: the loop runs on gemini and falls back to nano', () => {
    const e = env({ nano: true, gemini: true });
    expect(ids(providerChain('loop', e))).toEqual(['gemini', 'nano']);
    expect(ids(providerChain('critic', e))).toEqual(['gemini']);
    expect(ids(providerChain('vision', e))).toEqual(['gemini']);
  });

  it('anthropic-only + nano: Claude Haiku now covers vision as the fallback', () => {
    const e = env({ nano: true, anthropic: true }, 'anthropic');
    expect(ids(providerChain('loop', e))).toEqual(['anthropic', 'nano']);
    expect(ids(providerChain('critic', e))).toEqual(['anthropic']);
    expect(ids(providerChain('vision', e))).toEqual(['anthropic']);
  });

  it('anthropic-only, no nano: a role whose tier omits anthropic still resolves', () => {
    // 'classify' is ['nano','gemini'] — neither is available, so the last-resort
    // order applies. This is the case hasCloudKey covers today.
    const e = env({ anthropic: true }, 'anthropic');
    expect(ids(providerChain('classify', e))).toEqual(['anthropic']);
    expect(ids(providerChain('loop', e))).toEqual(['anthropic']);
  });

  it('nano-only: the loop head is nano, which callers read as "use the legacy path"', () => {
    const e = env({ nano: true });
    expect(ids(providerChain('loop', e))).toEqual(['nano']);
    expect(ids(providerChain('critic', e))).toEqual(['nano']);
    expect(ids(providerChain('vision', e))).toEqual([]);
  });

  it('nothing available yields an empty chain for every role', () => {
    const e = env({});
    expect(ids(providerChain('loop', e))).toEqual([]);
    expect(ids(providerChain('chat', e))).toEqual([]);
  });

  it('preferred does NOT reorder a role tier', () => {
    // The whole point of role-tiering: with both keys configured, plan/critic
    // still reach for Claude even though the default preference is Gemini.
    const geminiPreferred = env({ gemini: true, anthropic: true }, 'gemini');
    expect(ids(providerChain('plan', geminiPreferred))).toEqual(['anthropic', 'gemini']);
    expect(ids(providerChain('critic', geminiPreferred))).toEqual(['anthropic', 'gemini']);
    expect(ids(providerChain('loop', geminiPreferred))).toEqual(['gemini', 'anthropic']);

    const anthropicPreferred = env({ gemini: true, anthropic: true }, 'anthropic');
    expect(ids(providerChain('chat', anthropicPreferred))).toEqual(['gemini', 'anthropic']);
  });

  it('preferred orders only the last-resort fallback', () => {
    // 'classify' is ['nano','gemini']; with neither available the fallback runs,
    // and there the user's preference is the only signal available.
    const anthropicPreferred = env({ anthropic: true, gemini: false }, 'anthropic');
    expect(ids(providerChain('classify', anthropicPreferred))).toEqual(['anthropic']);

    const bothAvailable = env({ gemini: true, anthropic: true }, 'anthropic');
    // 'vision' is [gemini, anthropic] and both are available, so the tier is
    // returned verbatim (preference never reorders a matched tier)
    expect(ids(providerChain('vision', bothAvailable))).toEqual(['gemini', 'anthropic']);
  });

  it('preference is ignored when only one cloud is configured', () => {
    // An anthropic-preferring user with only a Gemini key still gets Gemini,
    // rather than the nothing-at-all that hasCloudKey gives them today.
    const e = env({ gemini: true }, 'anthropic');
    expect(ids(providerChain('chat', e))).toEqual(['gemini']);
    expect(ids(providerChain('plan', e))).toEqual(['gemini']);
  });
});

describe('providerChain with a local model', () => {
  it('ollama sits beside nano in the local-first roles', () => {
    const e = env({ nano: true, ollama: true, gemini: true, anthropic: true });
    expect(ids(providerChain('classify', e))).toEqual(['nano', 'ollama', 'gemini']);
    expect(ids(providerChain('extract', e))).toEqual(['nano', 'ollama', 'gemini', 'anthropic']);
  });

  it('ollama outranks nano in the loop — it has native function calling', () => {
    const e = env({ nano: true, ollama: true, gemini: true, anthropic: true });
    expect(ids(providerChain('loop', e))).toEqual(['gemini', 'anthropic', 'ollama', 'nano']);
  });

  it('a Brave user with only a local model gets a loop head that is not nano', () => {
    // The scenario this whole provider exists for: no Nano, no cloud key.
    // The head must not be 'nano', or runReactLoop returns 'unsupported'.
    const e = env({ ollama: true });
    expect(ids(providerChain('loop', e))).toEqual(['ollama']);
    expect(ids(providerChain('chat', e))).toEqual(['ollama']);
    expect(ids(providerChain('classify', e))).toEqual(['ollama']);
  });

  it('vision still has no substitute — a local text model is not one', () => {
    expect(ids(providerChain('vision', env({ ollama: true, nano: true })))).toEqual([]);
  });
});

describe('cloudFor', () => {
  it('skips nano at the head of a chain', () => {
    expect(cloudFor('classify', env({ nano: true, gemini: true }))?.id).toBe('gemini');
  });

  it('is undefined when only nano is available', () => {
    expect(cloudFor('classify', env({ nano: true }))).toBeUndefined();
  });

  it('does not treat a local model as a cloud escalation', () => {
    // assistant.ts calls this to escalate OFF the local path once input passes
    // the Nano budget. Returning ollama would escalate local -> local.
    expect(cloudFor('classify', env({ nano: true, ollama: true }))).toBeUndefined();
    expect(cloudFor('chat', env({ ollama: true }))).toBeUndefined();
  });

  it('skips past a local model to reach a real cloud', () => {
    expect(cloudFor('extract', env({ nano: true, ollama: true, gemini: true }))?.id).toBe('gemini');
  });
});

describe('resolveRoutingEnv', () => {
  it('performs ZERO probes when availability is supplied', async () => {
    const n = fake('nano');
    const cloud = fake('gemini');
    const resolved = await resolveRoutingEnv({
      nano: n,
      cloud,
      availability: { nano: true, cloud: true },
    });
    expect(n.available).not.toHaveBeenCalled();
    expect(cloud.available).not.toHaveBeenCalled();
    expect(resolved.available).toEqual({
      nano: true,
      gemini: true,
      anthropic: false,
      ollama: false,
    });
  });

  it('maps a passed-in {nano, cloud} pair onto the cloud provider it describes', async () => {
    const resolved = await resolveRoutingEnv({
      nano,
      cloud: fake('anthropic'),
      availability: { nano: false, cloud: true },
    });
    // The unprobed cloud is treated as unavailable rather than assumed present
    expect(resolved.available).toEqual({
      nano: false,
      gemini: false,
      anthropic: true,
      ollama: false,
    });
  });

  it('honors explicit per-cloud availability over the single cloud flag', async () => {
    const resolved = await resolveRoutingEnv({
      nano,
      cloud: fake('gemini'),
      availability: { nano: true, cloud: false, gemini: true, anthropic: true },
    });
    expect(resolved.available).toEqual({
      nano: true,
      gemini: true,
      anthropic: true,
      ollama: false,
    });
  });

  it('lets a caller-supplied cloud override the module singleton for its id', async () => {
    const injected = fake('gemini');
    const resolved = await resolveRoutingEnv({
      nano,
      cloud: injected,
      availability: { nano: true, cloud: true },
    });
    expect(resolved.providers.gemini).toBe(injected);
  });

  it('defaults preferred to gemini when settings are not supplied', async () => {
    const resolved = await resolveRoutingEnv({
      nano,
      availability: { nano: true, cloud: false },
    });
    expect(resolved.preferred).toBe('gemini');
  });
});
