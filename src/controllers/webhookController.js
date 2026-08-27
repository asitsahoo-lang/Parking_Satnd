const crypto = require("crypto");
const Ticket = require("../models/Ticket");
const { finalizeTicketClose } = require("./ticketController");

// ---------------------------------------------------------------------------
// POST /api/webhooks/razorpay
// Razorpay calls this directly (no JWT — verified by HMAC signature instead).
// We only act on "qr_code.credited", which fires the instant a customer's
// UPI payment against our dynamic QR is confirmed. This is what makes the
// whole thing "real-time": the agent's app is polling /upi/status and sees
// the ticket flip to CLOSED within a couple of seconds of the customer
// completing payment in their own UPI app — nobody has to tap anything.
//
// IMPORTANT: this route must receive the RAW request body for signature
// verification, not the JSON-parsed body — see app.js, where express.json()
// is configured with a `verify` callback that stashes req.rawBody.
// ---------------------------------------------------------------------------
async function handleRazorpayWebhook(req, res) {
  try {
    const signature = req.headers["x-razorpay-signature"];
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

    if (!secret) {
      console.error("RAZORPAY_WEBHOOK_SECRET not set — rejecting webhook");
      return res.status(500).send("Webhook secret not configured");
    }
    if (!signature || !req.rawBody) {
      return res.status(400).send("Missing signature or body");
    }

    const expected = crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");
    const valid =
      expected.length === signature.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));

    if (!valid) {
      console.warn("Razorpay webhook: signature mismatch — possible spoofed request");
      return res.status(400).send("Invalid signature");
    }

    const event = req.body.event;

    // Acknowledge everything else with 200 so Razorpay doesn't keep retrying
    // events we don't care about, but only act on the one we need.
    if (event !== "qr_code.credited") {
      return res.status(200).json({ received: true, ignored: event });
    }

    const qrEntity = req.body.payload?.qr_code?.entity;
    const paymentEntity = req.body.payload?.payment?.entity;

    if (!qrEntity || !paymentEntity) {
      console.warn("Razorpay webhook: qr_code.credited missing expected payload shape");
      return res.status(200).json({ received: true, warning: "unexpected payload shape" });
    }

    const ticket = await Ticket.findOne({ "upi.qrId": qrEntity.id });
    if (!ticket) {
      console.warn(`Razorpay webhook: no ticket found for QR ${qrEntity.id}`);
      return res.status(200).json({ received: true, warning: "no matching ticket" });
    }

    // Idempotency: Razorpay may retry webhook delivery. If we've already
    // closed this ticket (e.g. from a previous delivery of this same
    // event), just acknowledge without doing it twice.
    if (ticket.status === "CLOSED") {
      return res.status(200).json({ received: true, alreadyClosed: true });
    }

    ticket.upi.status = "PAID";
    ticket.upi.paymentId = paymentEntity.id;

    await finalizeTicketClose(ticket, {
      paymentStatus: "PAID",
      paymentMethod: "UPI",
      // No agent physically tapped "close" here — payment confirmation
      // itself is the trigger. Attribute it to whichever agent opened the
      // QR in the first place (recorded in the UPI_QR_CREATED audit entry)
      // by falling back to the entry agent if that's not resolvable here.
      exitAgentId: ticket.exitAgentId || ticket.entryAgentId,
      exitAgentName: ticket.exitAgentName || `${ticket.entryAgentName} (UPI auto-confirmed)`,
      exitTime: new Date(),
      auditNote: `UPI payment confirmed via Razorpay (payment ${paymentEntity.id}). Auto-closed.`,
    });

    console.log(`Ticket ${ticket.ticketId} auto-closed via Razorpay UPI payment ${paymentEntity.id}`);
    return res.status(200).json({ received: true, ticketClosed: true });
  } catch (err) {
    console.error("handleRazorpayWebhook error:", err);
    // Still 200 unless it's truly our fault being down — Razorpay will
    // retry on non-2xx, which is fine for transient errors, but an
    // unhandled exception here shouldn't loop forever on a bad payload.
    return res.status(500).json({ error: "Webhook processing failed" });
  }
}

module.exports = { handleRazorpayWebhook };
