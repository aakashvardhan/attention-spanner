/**
 * Single-user(s) allowlist: `ALLOWED_USERS="15551234567:<firebaseUid>,..."`.
 * Unknown senders are dropped silently — no reply, no LLM, no Firestore;
 * the webhook's abuse surface stays zero.
 */

export function parseAllowlist(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of raw.split(',')) {
    const [phone, uid] = pair.split(':').map((s) => s.trim());
    if (phone && uid) map.set(normalizePhone(phone), uid);
  }
  return map;
}

/** Meta sends wa_id without '+'; tolerate either form in config */
export function normalizePhone(phone: string): string {
  return phone.replace(/[^\d]/g, '');
}

export function uidForPhone(allowlist: Map<string, string>, phone: string): string | null {
  return allowlist.get(normalizePhone(phone)) ?? null;
}
