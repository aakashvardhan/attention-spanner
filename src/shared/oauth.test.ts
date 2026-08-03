import { describe, expect, it } from 'vitest';
import { emailFromIdToken, randomUrlSafe, s256Challenge } from './oauth';

/**
 * The PKCE core both connectors run their authorization-code flow on
 * (alphaXiv, Google Calendar). Pure, so it tests without a browser — which is
 * the point: a silent regression here weakens every sign-in at once.
 */

/** What Google/alphaXiv will accept: base64url, no padding, no + or /. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

describe('randomUrlSafe', () => {
  it('emits unpadded base64url', () => {
    for (const bytes of [16, 32]) {
      const value = randomUrlSafe(bytes);
      expect(value).toMatch(BASE64URL);
      expect(value).not.toContain('=');
    }
  });

  it('carries the requested entropy', () => {
    // base64 is 4 chars per 3 bytes, unpadded
    expect(randomUrlSafe(32).length).toBe(Math.ceil((32 * 4) / 3));
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 50 }, () => randomUrlSafe(32)));
    expect(seen.size).toBe(50);
  });
});

describe('s256Challenge', () => {
  it('matches the RFC 7636 appendix B test vector', async () => {
    // The one vector every server implements against — if this drifts, PKCE
    // silently stops verifying.
    expect(await s256Challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('is deterministic and base64url', async () => {
    const verifier = randomUrlSafe(32);
    const challenge = await s256Challenge(verifier);
    expect(challenge).toMatch(BASE64URL);
    expect(challenge).not.toContain('=');
    expect(await s256Challenge(verifier)).toBe(challenge);
  });

  it('differs for different verifiers', async () => {
    expect(await s256Challenge('a')).not.toBe(await s256Challenge('b'));
  });
});

describe('emailFromIdToken', () => {
  /** Sign-free id_token: only the payload is ever read. */
  const idToken = (payload: object) =>
    `header.${btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.sig`;

  it('reads the email claim', () => {
    expect(emailFromIdToken(idToken({ email: 'a@example.com', sub: '1' }))).toBe('a@example.com');
  });

  it('decodes a base64url payload containing - and _', () => {
    // A payload whose base64 lands on + or / must still decode; the swap back
    // is the whole reason this isn't a plain atob.
    const payload = { email: 'a@example.com', name: 'ÿÿÿ>>>???' };
    expect(emailFromIdToken(idToken(payload))).toBe('a@example.com');
  });

  it('returns empty rather than throwing on junk', () => {
    for (const bad of [undefined, '', 'not-a-jwt', 'a.!!!not-base64!!!.c', 'a..c']) {
      expect(emailFromIdToken(bad)).toBe('');
    }
  });

  it('ignores a non-string email claim', () => {
    expect(emailFromIdToken(idToken({ email: 42 }))).toBe('');
    expect(emailFromIdToken(idToken({ sub: '1' }))).toBe('');
  });
});
