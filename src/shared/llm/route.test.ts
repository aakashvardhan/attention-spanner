import { describe, expect, it } from 'vitest';
import { CLAUDE_MODELS } from '../constants';
import { route } from './route';

describe('route', () => {
  it('uses Haiku when there is a key and a network', () => {
    expect(route({ online: true, hasKey: true })).toMatchObject({ target: 'claude', model: CLAUDE_MODELS.quick });
  });
  it('asks for a key before anything else', () => {
    expect(route({ online: false, hasKey: false })).toEqual({ target: 'none', reason: 'Add a Claude API key in Settings' });
  });
  it('says offline when the key is there but the network is not', () => {
    expect(route({ online: false, hasKey: true })).toEqual({ target: 'none', reason: 'You are offline' });
  });
});
