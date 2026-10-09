import { describe, expect, it } from 'vitest';
import { NETWORK_NOISE } from './noise';

const tolerated = (error: string) => NETWORK_NOISE.some((re) => re.test(error));

describe('NETWORK_NOISE', () => {
  it('tolerates failed requests to the suite’s own fake hosts and the dead Ollama port', () => {
    expect(tolerated('console: Failed to load resource: net::ERR_CONNECTION_REFUSED (http://127.0.0.1:9/api/tags)')).toBe(true);
    expect(tolerated('console: Failed to load resource: the server responded with a status of 500 (Internal Server Error) (http://broken.e2e.test:5555/)')).toBe(true);
    expect(tolerated('console: Failed to load resource: net::ERR_CONNECTION_REFUSED (http://news.e2e.test/f1)')).toBe(true);
  });

  it('never tolerates a missing extension asset, a real site, or an exception', () => {
    expect(tolerated('console: Failed to load resource: net::ERR_FILE_NOT_FOUND (chrome-extension://abc/assets/font.woff2)')).toBe(false);
    expect(tolerated('console: Failed to load resource: net::ERR_NAME_NOT_RESOLVED (https://api.open-meteo.com/v1/forecast)')).toBe(false);
    expect(tolerated('uncaught: Cannot read properties of undefined')).toBe(false);
  });
});
