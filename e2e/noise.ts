/**
 * Console errors the suite causes on purpose: requests to its own fake sites
 * (*.e2e.test) and to the dead Ollama port on 127.0.0.1. Chrome logs one for
 * every refused connection and 4xx/5xx answer. Anything else, a missing
 * extension asset above all, still fails the test.
 */
export const NETWORK_NOISE = [
  /^console: Failed to load resource: .*\(https?:\/\/(127\.0\.0\.1|[\w-]+\.e2e\.test)[:/][^)]*\)$/,
];
