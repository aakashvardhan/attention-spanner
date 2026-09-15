"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendText = sendText;
/** Meta Cloud API sender. Replies are blunt and plain: no emojis, no filler. */
async function sendText(phoneNumberId, accessToken, to, body) {
    const res = await fetch(`https://graph.facebook.com/v23.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            messaging_product: 'whatsapp',
            to,
            type: 'text',
            text: { body: body.slice(0, 4000) },
        }),
    });
    if (!res.ok) {
        console.error('WhatsApp send failed', res.status, await res.text().catch(() => ''));
    }
}
//# sourceMappingURL=reply.js.map