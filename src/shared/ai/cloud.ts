import type { Settings } from '../types';
import { anthropicProvider } from './anthropicProvider';
import type { AssistantProvider } from './assistantTypes';
import { geminiProvider } from './geminiProvider';

/**
 * Which cloud provider the assistant uses when it escalates off on-device Nano.
 * The user chooses in Settings → Assistant; every surface (chat, reader Q&A)
 * resolves the provider through here so the choice lives in one place.
 */
export function cloudProviderFor(settings: Pick<Settings, 'cloudProvider'>): AssistantProvider {
  return settings.cloudProvider === 'anthropic' ? anthropicProvider : geminiProvider;
}

/** Whether the selected cloud provider has a key configured. */
export function hasCloudKey(
  settings: Pick<Settings, 'cloudProvider' | 'geminiApiKey' | 'anthropicApiKey'>,
): boolean {
  return settings.cloudProvider === 'anthropic'
    ? settings.anthropicApiKey.trim() !== ''
    : settings.geminiApiKey.trim() !== '';
}
