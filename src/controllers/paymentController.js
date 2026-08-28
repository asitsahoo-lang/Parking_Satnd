const Ticket = require("../models/Ticket");
const { getRazorpayClient } = require("../config/razorpay");
const { calculateFee } = require("../utils/fee");

// ---------------------------------------------------------------------------
// POST /api/tickets/:id/upi/create
// Generates a Razorpay dynamic, single-use UPI QR for this ticket's
// auto-calculated fee. Agent's app displays qrImageUrl; customer scans with
// ANY UPI app (GPay/PhonePe/etc — doesn't have to be Razorpay's app). The
// moment Razorpay confirms the payment, it calls our webhook, which closes
// the ticket automatically — see webhookController.js.
// ---------------------------------------------------------------------------
async function createUpiQr(req, res) {
  try {
    const ticket = await Ticket.findOne({ ticketId: req.params.id });
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });

    if (ticket.status === "CLOSED") {
      return res.status(409).json({ error: "Ticket is already closed" });
    }
    if (ticket.paymentStatus === "PAID") {
      return res.status(400).json({ error: "Ticket is already marked paid" });
    }
    if (ticket.upi && ticket.upi.status === "CREATED") {
      // Re-serve the existing active QR rather than generating a duplicate
      return res.json({
        qrId: ticket.upi.qrId,
        qrImageUrl: ticket.upi.qrImageUrl,
        amount: ticket.feeAmount,
      });
    }

    const fee = calculateFee(ticket.entryTime, new Date());
    ticket.feeAmount = fee.amount;

    const razorpay = getRazorpayClient();
    const closeBy = Math.floor(Date.now() / 1000) + 10 * 60; // QR expires in 10 minutes

    const qr = await razorpay.qrCode.create({
      type: "upi_qr",
      name: `Parking - ${ticket.plateNumber}`,
      usage: "single_use",
      fixed_amount: true,
      payment_amount: Math.round(fee.amount * 100), // Razorpay expects paise
      description: `Parking fee for ${ticket.plateNumber}`,
      close_by: closeBy,
      notes: {
        ticketId: ticket.ticketId,
        plateNumber: ticket.plateNumber,
      },
    });

    ticket.upi = {
      qrId: qr.id,
      qrImageUrl: qr.image_url,
      status: "CREATED",
      amount: qr.payment_amount,
      createdAt: new Date(),
    };
    ticket.audit.push({
      action: "UPI_QR_CREATED",
      agentId: req.user.loginId,
      agentName: req.user.name,
      note: `Razorpay UPI QR generated for amount ${fee.amount}`,
    });
    await ticket.save();

    return res.status(201).json({
      qrId: qr.id,
      qrImageUrl: qr.image_url,
      amount: fee.amount,
      expiresAt: new Date(closeBy * 1000),
    });
  } catch (err) {
    console.error("createUpiQr error:", err);
    return res.status(500).json({ error: "Failed to create UPI QR", details: err.message });
  }
}

// ---------------------------------------------------------------------------
// GET /api/tickets/:id/upi/status
// Polled by the Flutter app every couple seconds while the QR is on screen.
// Real confirmation comes from the webhook updating the DB — this endpoint
// just reads whatever the webhook has already written.
// ---------------------------------------------------------------------------
async function getUpiStatus(req, res) {
  try {
    const ticket = await Ticket.findOne({ ticketId: req.params.id }).select("upi status paymentStatus exitTime exitAgentName");
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });

    return res.json({
      upiStatus: ticket.upi ? ticket.upi.status : "NONE",
      ticketStatus: ticket.status,
      paymentStatus: ticket.paymentStatus,
      closedAt: ticket.exitTime,
      closedBy: ticket.exitAgentName,
    });
  } catch (err) {
    console.error("getUpiStatus error:", err);
    return res.status(500).json({ error: "Failed to fetch UPI status" });
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/tickets/:id/upi/cancel
// Agent backs out of UPI collection (customer wants to pay cash instead, or
// the QR is about to expire) — clears the CREATED lock so a manual close is
// allowed again.
// ---------------------------------------------------------------------------
async function cancelUpiQr(req, res) {
  try {
    const ticket = await Ticket.findOne({ ticketId: req.params.id });
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });

    if (ticket.upi && ticket.upi.status === "CREATED") {
      try {
        const razorpay = getRazorpayClient();
        await razorpay.qrCode.close(ticket.upi.qrId);
      } catch (e) {
        // Non-fatal — QR may have already expired on Razorpay's side
        console.warn("Razorpay QR close warning:", e.message);
      }
      ticket.upi.status = "CANCELLED";
      ticket.audit.push({
        action: "UPI_QR_CANCELLED",
        agentId: req.user.loginId,
        agentName: req.user.name,
        note: "Agent cancelled UPI collection",
      });
      await ticket.save();
    }

    return res.json({ ticket });
  } catch (err) {
    console.error("cancelUpiQr error:", err);
    return res.status(500).json({ error: "Failed to cancel UPI QR" });
  }
}

// ---------------------------------------------------------------------------
// FALLBACK PATH — Payment Links (upi_link) instead of the QR Code API.
//
// Same end result for the customer (scan a QR, pay via UPI), but built on
// Razorpay's Payment Links product instead of the QR Code product, in case
// QR Codes isn't API-enabled on this account yet. Razorpay gives us back a
// short_url — we don't get a ready-made QR image this time, so the QR is
// drawn client-side in Flutter (qr_flutter) from that URL. Scanning it opens
// either the customer's UPI app directly (upi_link: true asks Razorpay to
// prefer a UPI intent) or a Razorpay-hosted checkout page with UPI as an
// option, depending on what app handles the scan.
// ---------------------------------------------------------------------------

// POST /api/tickets/:id/paymentlink/create
async function createPaymentLink(req, res) {
  try {
    const ticket = await Ticket.findOne({ ticketId: req.params.id });
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });

    if (ticket.status === "CLOSED") {
      return res.status(409).json({ error: "Ticket is already closed" });
    }
    if (ticket.paymentStatus === "PAID") {
      return res.status(400).json({ error: "Ticket is already marked paid" });
    }
    if (ticket.paymentLink && ticket.paymentLink.status === "CREATED") {
      return res.json({
        linkId: ticket.paymentLink.linkId,
        shortUrl: ticket.paymentLink.shortUrl,
        amount: ticket.feeAmount,
      });
    }

    const fee = calculateFee(ticket.entryTime, new Date());
    ticket.feeAmount = fee.amount;

    const razorpay = getRazorpayClient();
    const expireBy = Math.floor(Date.now() / 1000) + 10 * 60;

    const link = await razorpay.paymentLink.create({
      upi_link: true,
      amount: Math.round(fee.amount * 100),
      currency: "INR",
      accept_partial: false,
      description: `Parking fee for ${ticket.plateNumber}`,
      expire_by: expireBy,
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: {
        ticketId: ticket.ticketId,
        plateNumber: ticket.plateNumber,
      },
    });

    ticket.paymentLink = {
      linkId: link.id,
      shortUrl: link.short_url,
      status: "CREATED",
      amount: link.amount,
      createdAt: new Date(),
    };
    ticket.audit.push({
      action: "PAYMENT_LINK_CREATED",
      agentId: req.user.loginId,
      agentName: req.user.name,
      note: `Razorpay Payment Link generated for amount ${fee.amount}`,
    });
    await ticket.save();

    return res.status(201).json({
      linkId: link.id,
      shortUrl: link.short_url,
      amount: fee.amount,
      expiresAt: new Date(expireBy * 1000),
    });
  } catch (err) {
    console.error("createPaymentLink error:", err);
    return res.status(500).json({ error: "Failed to create payment link", details: err.message });
  }
}

// GET /api/tickets/:id/paymentlink/status
async function getPaymentLinkStatus(req, res) {
  try {
    const ticket = await Ticket.findOne({ ticketId: req.params.id }).select(
      "paymentLink status paymentStatus exitTime exitAgentName"
    );
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });

    return res.json({
      linkStatus: ticket.paymentLink ? ticket.paymentLink.status : "NONE",
      ticketStatus: ticket.status,
      paymentStatus: ticket.paymentStatus,
      closedAt: ticket.exitTime,
      closedBy: ticket.exitAgentName,
    });
  } catch (err) {
    console.error("getPaymentLinkStatus error:", err);
    return res.status(500).json({ error: "Failed to fetch payment link status" });
  }
}

// PATCH /api/tickets/:id/paymentlink/cancel
async function cancelPaymentLink(req, res) {
  try {
    const ticket = await Ticket.findOne({ ticketId: req.params.id });
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });

    if (ticket.paymentLink && ticket.paymentLink.status === "CREATED") {
      try {
        const razorpay = getRazorpayClient();
        await razorpay.paymentLink.cancel(ticket.paymentLink.linkId);
      } catch (e) {
        console.warn("Razorpay payment link cancel warning:", e.message);
      }
      ticket.paymentLink.status = "CANCELLED";
      ticket.audit.push({
        action: "PAYMENT_LINK_CANCELLED",
        agentId: req.user.loginId,
        agentName: req.user.name,
        note: "Agent cancelled payment link collection",
      });
      await ticket.save();
    }

    return res.json({ ticket });
  } catch (err) {
    console.error("cancelPaymentLink error:", err);
    return res.status(500).json({ error: "Failed to cancel payment link" });
  }
}

module.exports = { createUpiQr, getUpiStatus, cancelUpiQr, createPaymentLink, getPaymentLinkStatus, cancelPaymentLink };
