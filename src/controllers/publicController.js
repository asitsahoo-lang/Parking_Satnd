const Ticket = require("../models/Ticket");
const { verifyTicketSignature } = require("../utils/hmac");

// ---------------------------------------------------------------------------
// GET /api/public/verify/:id?sig=...
// Used by an agent's app (or anyone) to confirm a QR's signature is genuine
// before trusting the ticketId at all.
// ---------------------------------------------------------------------------
async function verifyQr(req, res) {
  const { id } = req.params;
  const { sig } = req.query;

  const valid = verifyTicketSignature(id, sig);
  if (!valid) {
    return res.status(400).json({ valid: false, error: "Signature does not match — possible forged/tampered QR" });
  }
  return res.json({ valid: true });
}

// ---------------------------------------------------------------------------
// GET /t/:id  — the "lightweight webpage" a customer's camera opens when they
// scan the QR. No login, no app install. Just proof-of-parking they can
// screenshot. Served directly from this same Express backend — no separate
// site/hosting needed.
// ---------------------------------------------------------------------------
async function ticketPage(req, res) {
  const { id } = req.params;
  const { sig } = req.query;

  const ticket = await Ticket.findOne({ ticketId: id });

  if (!ticket) {
    return res.status(404).send(renderPage({ error: "Ticket not found." }));
  }

  const sigOk = sig ? verifyTicketSignature(id, sig) : true; // tolerate missing sig for display-only
  if (!sigOk) {
    return res.status(400).send(renderPage({ error: "This QR code could not be verified." }));
  }

  return res.send(renderPage({ ticket }));
}

function renderPage({ ticket, error }) {
  if (error) {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Parking Ticket</title>
<style>${baseStyles()}</style></head>
<body><div class="card"><h1>⚠️ ${error}</h1></div></body></html>`;
  }

  const statusColor = ticket.status === "OPEN" ? "#16a34a" : "#6b7280";
  const paymentColor =
    ticket.paymentStatus === "PAID" ? "#16a34a" : ticket.paymentStatus === "UNPAID" ? "#dc2626" : "#d97706";

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Parking Ticket — ${ticket.plateNumber}</title>
<style>${baseStyles()}</style></head>
<body>
  <div class="card">
    <h1>🎫 Parking Ticket</h1>
    <div class="plate">${ticket.plateNumber}</div>
    <table>
      <tr><td>Status</td><td><span class="badge" style="background:${statusColor}">${ticket.status}</span></td></tr>
      <tr><td>Payment</td><td><span class="badge" style="background:${paymentColor}">${ticket.paymentStatus}</span></td></tr>
      <tr><td>Entry Time</td><td>${new Date(ticket.entryTime).toLocaleString()}</td></tr>
      ${ticket.exitTime ? `<tr><td>Exit Time</td><td>${new Date(ticket.exitTime).toLocaleString()}</td></tr>` : ""}
      <tr><td>Ticket ID</td><td class="mono">${ticket.ticketId}</td></tr>
    </table>
    <p class="hint">Keep this page or a screenshot as your proof of parking. Show it to any agent when you return for your vehicle.</p>
  </div>
</body></html>`;
}

function baseStyles() {
  return `
    body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; background:#f3f4f6; margin:0; padding:24px; display:flex; justify-content:center; }
    .card { background:#fff; border-radius:16px; padding:24px; max-width:420px; width:100%; box-shadow:0 2px 12px rgba(0,0,0,0.08); }
    h1 { font-size:20px; margin:0 0 16px; }
    .plate { font-size:28px; font-weight:700; letter-spacing:2px; text-align:center; padding:12px; border:2px dashed #111827; border-radius:8px; margin-bottom:16px; }
    table { width:100%; border-collapse:collapse; }
    td { padding:8px 4px; border-bottom:1px solid #e5e7eb; font-size:14px; }
    td:first-child { color:#6b7280; }
    .badge { color:#fff; padding:2px 10px; border-radius:999px; font-size:12px; font-weight:600; }
    .mono { font-family: monospace; font-size:12px; word-break: break-all; }
    .hint { font-size:12px; color:#6b7280; margin-top:16px; text-align:center; }
  `;
}

module.exports = { verifyQr, ticketPage };
