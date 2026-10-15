declare const process: { env: Record<string, string | undefined> };

/** Property tests share one seed so CI is repeatable; fast-check prints it on failure. Override with FC_SEED. */
export const FC = { seed: Number(process.env.FC_SEED ?? 20261014), numRuns: 200 };
