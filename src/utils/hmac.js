const crypto = require("crypto");

/**
 * Signs a ticketId with the server's secret so the QR content can't be
 * forged or guessed. The Flutter app embeds { ticketId, signature } in the
 * QR code. Anyone scanning it can be verified server-side via /api/public/verify.
 */
function signTicketId(ticketId) {
  const secret = process.env.QR_HMAC_SECRET;
  if (!secret) {
    throw new Error("QR_HMAC_SECRET is not set in .env");
  }
  return crypto.createHmac("sha256", secret).update(ticketId).digest("hex");
}

function verifyTicketSignature(ticketId, signature) {
  if (!ticketId || !signature) return false;
  const expected = signTicketId(ticketId);
  // timing-safe comparison
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { signTicketId, verifyTicketSignature };
