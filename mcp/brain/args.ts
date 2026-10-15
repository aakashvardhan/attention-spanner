import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

/** Prompts for the interactive commands; tests pass a scripted one instead. */
export interface Io { ask(prompt: string): Promise<string>; say(text: string): void; now(): number }

export function vaultPath(flag?: string): string {
  const v = flag ?? process.env.BRAIN_VAULT;
  if (!v) throw new Error('Give --vault <folder> or set BRAIN_VAULT to the vault folder.');
  return v;
}

/** Personal results go here, inside the vault, never into the repo. */
export async function reportsDir(vault: string): Promise<string> {
  const dir = join(vault, '.brain', 'reports');
  await mkdir(dir, { recursive: true });
  return dir;
}

export function terminal(): Io & { close(): void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return { ask: (p) => rl.question(p), say: (t) => console.log(t), now: () => Date.now(), close: () => rl.close() };
}
