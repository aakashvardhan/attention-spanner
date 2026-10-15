import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { vaultPath } from './args';

let dir = '';
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'brain-args-'));
  await writeFile(join(dir, 'file.md'), '');
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('vaultPath', () => {
  it('accepts an existing folder and returns its absolute path', () => {
    expect(vaultPath(dir)).toBe(dir);
  });
  it('refuses a folder that does not exist instead of letting a write create it', () => {
    expect(() => vaultPath(join(dir, 'missing'))).toThrow(/is not a folder/);
  });
  it('refuses a file', () => {
    expect(() => vaultPath(join(dir, 'file.md'))).toThrow(/is not a folder/);
  });
  it('names an unexpanded variable, the mistake .mcp.json makes when BRAIN_VAULT is not in Claude Code\'s environment', () => {
    expect(() => vaultPath('${BRAIN_VAULT}')).toThrow(/BRAIN_VAULT was not set where Claude Code started/);
  });
});
