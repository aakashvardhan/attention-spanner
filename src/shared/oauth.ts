/**
 * Bits shared by the connectors that run the authorization-code flow themselves
 * (alphaXiv, Google Calendar): PKCE, and reading a display email out of an
 * id_token. Pure — no chrome APIs, no network, so it unit-tests anywhere.
 */

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** URL-safe random string carrying `byteLength` bytes of entropy. */
export function randomUrlSafe(byteLength: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** S256 PKCE challenge for a verifier from `randomUrlSafe`. */
export async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/** Best-effort email from the id_token's payload — display only, never trusted. */
export function emailFromIdToken(idToken: string | undefined): string {
  if (!idToken) return '';
  try {
    const payload = idToken.split('.')[1];
    if (!payload) return '';
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as {
      email?: unknown;
    };
    return typeof json.email === 'string' ? json.email : '';
  } catch {
    return '';
  }
}
