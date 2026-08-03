import { describe, expect, it } from 'vitest';
import { anthropicProvider } from './anthropicProvider';
import { cloudProviderFor, hasCloudKey } from './cloud';
import { geminiProvider } from './geminiProvider';

describe('cloudProviderFor', () => {
  it('selects the provider named in settings', () => {
    expect(cloudProviderFor({ cloudProvider: 'gemini' })).toBe(geminiProvider);
    expect(cloudProviderFor({ cloudProvider: 'anthropic' })).toBe(anthropicProvider);
  });
});

describe('hasCloudKey', () => {
  const base = { cloudProvider: 'gemini' as const, geminiApiKey: '', anthropicApiKey: '' };

  it('checks only the selected provider’s key', () => {
    expect(hasCloudKey({ ...base, cloudProvider: 'gemini', geminiApiKey: 'g' })).toBe(true);
    expect(hasCloudKey({ ...base, cloudProvider: 'gemini', anthropicApiKey: 'a' })).toBe(false);
    expect(hasCloudKey({ ...base, cloudProvider: 'anthropic', anthropicApiKey: 'a' })).toBe(true);
    expect(hasCloudKey({ ...base, cloudProvider: 'anthropic', geminiApiKey: 'g' })).toBe(false);
    expect(hasCloudKey({ ...base, cloudProvider: 'anthropic', anthropicApiKey: '   ' })).toBe(false);
  });
});
