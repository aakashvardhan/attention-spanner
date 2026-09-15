"use strict";
/**
 * Single-user(s) allowlist: `ALLOWED_USERS="15551234567:<firebaseUid>,..."`.
 * Unknown senders are dropped silently — no reply, no LLM, no Firestore;
 * the webhook's abuse surface stays zero.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseAllowlist = parseAllowlist;
exports.normalizePhone = normalizePhone;
exports.uidForPhone = uidForPhone;
function parseAllowlist(raw) {
    const map = new Map();
    for (const pair of raw.split(',')) {
        const [phone, uid] = pair.split(':').map((s) => s.trim());
        if (phone && uid)
            map.set(normalizePhone(phone), uid);
    }
    return map;
}
/** Meta sends wa_id without '+'; tolerate either form in config */
function normalizePhone(phone) {
    return phone.replace(/[^\d]/g, '');
}
function uidForPhone(allowlist, phone) {
    return allowlist.get(normalizePhone(phone)) ?? null;
}
//# sourceMappingURL=allowlist.js.map