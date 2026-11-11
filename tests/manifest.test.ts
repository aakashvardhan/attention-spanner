import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const patch = JSON.parse(readFileSync(resolve(__dirname, '../rust/ext/manifest.patch.json'), 'utf8'));

// The reader and blocked pages must be web-accessible: the arXiv and blocking
// redirects (declarativeNetRequest) land on them from any site. That alone
// would let any site frame `reader/index.html?src=...`; the CSP refuses it.
describe('manifest patch', () => {
  it('keeps the redirect targets web-accessible, but not frameable by websites', () => {
    const exposed = patch.web_accessible_resources.flatMap((r: { resources: string[] }) => r.resources);
    expect(exposed).toEqual(expect.arrayContaining(['src/pages/reader/index.html', 'src/pages/blocked/index.html']));
    const csp: string = patch.content_security_policy.extension_pages;
    expect(csp).toContain("frame-ancestors 'self'");
    // wasm needs this; MV3 allows nothing looser for scripts.
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
  });
});
