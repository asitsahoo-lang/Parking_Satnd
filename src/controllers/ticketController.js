const Ticket = require("../models/Ticket");
const { signTicketId, verifyTicketSignature } = require("../utils/hmac");
const { calculateFee } = require("../utils/fee");

const RETENTION_HOURS = () => Number(process.env.RETENTION_HOURS || 48);

function retentionDate(from = new Date()) {
  return new Date(from.getTime() + RETENTION_HOURS() * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Shared close logic — used by the manual PATCH /close endpoint AND by the
// Razorpay webhook once a real-time UPI payment is confirmed. Keeping this
// in one place means "what happens when a ticket closes" (status flip, QR
// invalidation, TTL purge date, audit log) never drifts between the two
// triggers.
// ---------------------------------------------------------------------------
async function finalizeTicketClose(ticket, { paymentStatus, paymentMethod, exitAgentId, exitAgentName, exitTime, auditNote }) {
  ticket.status = "CLOSED";
  ticket.paymentStatus = paymentStatus;
  ticket.paymentMethod = paymentMethod;
  ticket.exitAgentId = exitAgentId;
  ticket.exitAgentName = exitAgentName;
  ticket.exitTime = exitTime;
  ticket.deleteAfter = retentionDate(exitTime);

  ticket.audit.push({
    action: "CLOSED",
    agentId: exitAgentId,
    agentName: exitAgentName,
    note: auditNote || `Closed. Fee: ${ticket.feeAmount}, payment: ${ticket.paymentStatus}`,
  });

  await ticket.save();
  return ticket;
}

// ---------------------------------------------------------------------------
// POST /api/tickets
// Create a single ticket while online (normal path when agent has signal).
// ---------------------------------------------------------------------------
async function createTicket(req, res) {
  try {
    const {
      ticketId,
      plateNumber,
      ocrRawText,
      ocrConfidence,
      photoBase64,
      entryTime,
      paymentStatus,
      paymentMethod,
      deviceId,
    } = req.body;

    if (!ticketId || !plateNumber || !photoBase64 || !entryTime) {
      return res.status(400).json({
        error: "ticketId, plateNumber, photoBase64 and entryTime are required",
      });
    }

    const existing = await Ticket.findOne({ ticketId });
    if (existing) {
      return res.status(409).json({ error: "Ticket with this ticketId already exists", ticket: existing });
    }

    const qrSignature = signTicketId(ticketId);

    const ticket = await Ticket.create({
      ticketId,
      plateNumber,
      ocrRawText,
      ocrConfidence,
      photoBase64,
      qrSignature,
      qrSignedOffline: false,
      entryAgentId: req.user.loginId,
      entryAgentName: req.user.name,
      entryTime,
      paymentStatus: paymentStatus || "PENDING",
      paymentMethod: paymentMethod || "NONE",
      createdOffline: false,
      deviceId,
      audit: [
        {
          action: "CREATED",
          agentId: req.user.loginId,
          agentName: req.user.name,
          note: `Entry recorded, payment: ${paymentStatus || "PENDING"}`,
        },
      ],
    });

    return res.status(201).json({ ticket });
  } catch (err) {
    console.error("createTicket error:", err);
    return res.status(500).json({ error: "Failed to create ticket" });
  }
}

// ---------------------------------------------------------------------------
// POST /api/tickets/sync
// Batch upsert — this is the heart of offline-first sync. The Flutter app
// queues tickets (and status changes) created/edited while offline, then
// flushes the whole queue here the moment it regains connectivity.
//
// Conflict-free by design: every ticket carries a client-generated ticketId,
// so two agents can never collide creating the "same" ticket. For updates
// (e.g. a ticket closed offline), we trust the payload's status/exitTime as
// long as the current server status isn't already CLOSED from someone else
// with a LATER exitTime — last-write-wins on exitTime, first-close-wins on
// double-close attempts.
//
// body: { tickets: [ {ticketId, plateNumber, ..., status, exitTime, ...}, ... ] }
// ---------------------------------------------------------------------------
async function syncTickets(req, res) {
  try {
    const { tickets } = req.body;
    if (!Array.isArray(tickets) || tickets.length === 0) {
      return res.status(400).json({ error: "tickets array is required and cannot be empty" });
    }

    const results = [];

    for (const incoming of tickets) {
      try {
        if (!incoming.ticketId) {
          results.push({ ticketId: null, status: "error", error: "missing ticketId" });
          continue;
        }

        const existing = await Ticket.findOne({ ticketId: incoming.ticketId });

        if (!existing) {
          // Brand new ticket arriving from offline queue
          const qrSignature = signTicketId(incoming.ticketId);
          const created = await Ticket.create({
            ticketId: incoming.ticketId,
            plateNumber: incoming.plateNumber,
            ocrRawText: incoming.ocrRawText,
            ocrConfidence: incoming.ocrConfidence,
            photoBase64: incoming.photoBase64,
            qrSignature,
            qrSignedOffline: true, // was shown to customer before backend saw it
            status: incoming.status === "CLOSED" ? "CLOSED" : "OPEN",
            paymentStatus: incoming.paymentStatus || "PENDING",
            paymentMethod: incoming.paymentMethod || "NONE",
            feeAmount: incoming.feeAmount || 0,
            entryAgentId: incoming.entryAgentId || req.user.loginId,
            entryAgentName: incoming.entryAgentName || req.user.name,
            entryTime: incoming.entryTime,
            exitAgentId: incoming.exitAgentId,
            exitAgentName: incoming.exitAgentName,
            exitTime: incoming.exitTime,
            createdOffline: true,
            deviceId: incoming.deviceId,
            lastSyncedAt: new Date(),
            deleteAfter: incoming.status === "CLOSED" ? retentionDate() : null,
            audit: [
              {
                action: "CREATED_OFFLINE_SYNCED",
                agentId: incoming.entryAgentId || req.user.loginId,
                agentName: incoming.entryAgentName || req.user.name,
                note: "Ticket created offline, synced to server",
              },
              ...(incoming.status === "CLOSED"
                ? [
                    {
                      action: "CLOSED_OFFLINE_SYNCED",
                      agentId: incoming.exitAgentId,
                      agentName: incoming.exitAgentName,
                      note: "Ticket was also closed offline before sync",
                    },
                  ]
                : []),
            ],
          });
          results.push({ ticketId: incoming.ticketId, status: "created", ticket: created });
          continue;
        }

        // Ticket already exists on server — merge in any offline changes.
        // Never downgrade a CLOSED ticket back to OPEN via sync (only the
        // explicit reopen endpoint, owner-only, can do that).
        let changed = false;

        if (existing.status === "OPEN" && incoming.status === "CLOSED") {
          existing.status = "CLOSED";
          existing.exitAgentId = incoming.exitAgentId;
          existing.exitAgentName = incoming.exitAgentName;
          existing.exitTime = incoming.exitTime;
          existing.paymentStatus = incoming.paymentStatus || existing.paymentStatus;
          existing.paymentMethod = incoming.paymentMethod || existing.paymentMethod;
          existing.feeAmount = incoming.feeAmount || existing.feeAmount;
          existing.deleteAfter = retentionDate();
          existing.audit.push({
            action: "CLOSED_OFFLINE_SYNCED",
            agentId: incoming.exitAgentId,
            agentName: incoming.exitAgentName,
            note: "Closed offline, synced to server",
          });
          changed = true;
        } else if (existing.status === "OPEN" && incoming.paymentStatus && incoming.paymentStatus !== existing.paymentStatus) {
          existing.paymentStatus = incoming.paymentStatus;
          existing.paymentMethod = incoming.paymentMethod || existing.paymentMethod;
          existing.audit.push({
            action: "PAYMENT_UPDATED_OFFLINE_SYNCED",
            agentId: req.user.loginId,
            agentName: req.user.name,
            note: `Payment status synced to ${incoming.paymentStatus}`,
          });
          changed = true;
        }

        if (changed) {
          existing.lastSyncedAt = new Date();
          await existing.save();
          results.push({ ticketId: incoming.ticketId, status: "updated", ticket: existing });
        } else {
          results.push({ ticketId: incoming.ticketId, status: "unchanged", ticket: existing });
        }
      } catch (innerErr) {
        console.error("sync item error:", innerErr);
        results.push({ ticketId: incoming.ticketId || null, status: "error", error: innerErr.message });
      }
    }

    return res.json({ results });
  } catch (err) {
    console.error("syncTickets error:", err);
    return res.status(500).json({ error: "Sync failed" });
  }
}

// ---------------------------------------------------------------------------
// GET /api/tickets  — list, with filters (for the "all open tickets" pool
// every agent sees, and owner's audit views)
// query: ?status=OPEN&limit=50&page=1
// ---------------------------------------------------------------------------
async function listTickets(req, res) {
  try {
    const { status, limit = 50, page = 1 } = req.query;
    const filter = {};
    if (status) filter.status = status.toUpperCase();

    const tickets = await Ticket.find(filter)
      .sort({ entryTime: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit));

    const total = await Ticket.countDocuments(filter);

    return res.json({ tickets, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    console.error("listTickets error:", err);
    return res.status(500).json({ error: "Failed to fetch tickets" });
  }
}

// ---------------------------------------------------------------------------
// GET /api/tickets/:id  — fetch single ticket by ticketId (agent pickup scan)
// ---------------------------------------------------------------------------
async function getTicket(req, res) {
  try {
    const ticket = await Ticket.findOne({ ticketId: req.params.id });
    if (!ticket) {
      return res.status(404).json({ error: "Ticket not found" });
    }
    return res.json({ ticket });
  } catch (err) {
    console.error("getTicket error:", err);
    return res.status(500).json({ error: "Failed to fetch ticket" });
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/tickets/:id/payment  — update payment at entry or exit
// body: { paymentStatus: "PAID"|"PENDING"|"UNPAID", paymentMethod: "CASH"|"UPI" }
// ---------------------------------------------------------------------------
async function updatePayment(req, res) {
  try {
    const { paymentStatus, paymentMethod } = req.body;
    const ticket = await Ticket.findOne({ ticketId: req.params.id });
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    if (ticket.status === "CLOSED") {
      return res.status(400).json({ error: "Cannot modify payment on a closed ticket" });
    }

    if (paymentStatus) ticket.paymentStatus = paymentStatus;
    if (paymentMethod) ticket.paymentMethod = paymentMethod;
    ticket.audit.push({
      action: "PAYMENT_UPDATED",
      agentId: req.user.loginId,
      agentName: req.user.name,
      note: `Payment set to ${paymentStatus || ticket.paymentStatus}`,
    });

    await ticket.save();
    return res.json({ ticket });
  } catch (err) {
    console.error("updatePayment error:", err);
    return res.status(500).json({ error: "Failed to update payment" });
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/tickets/:id/close  — pickup flow: verify, auto-calc fee, close,
// invalidate QR, set TTL purge date.
// body: { paymentMethod?: "CASH"|"UPI", markUnpaid?: boolean, exitTime? }
// ---------------------------------------------------------------------------
async function closeTicket(req, res) {
  try {
    const ticket = await Ticket.findOne({ ticketId: req.params.id });
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });

    if (ticket.status === "CLOSED") {
      return res.status(409).json({
        error: `Already used — closed at ${ticket.exitTime} by ${ticket.exitAgentName}`,
        ticket,
      });
    }

      // If a Razorpay UPI QR or Payment Link is currently active for this
    // ticket, the customer may complete it while the agent is also
    // standing here — don't let a manual "cash" close race a payment
    // that's mid-flight. Agent must cancel it first (see cancelUpiQr /
    // cancelPaymentLink) before closing another way.
    if (ticket.upi && ticket.upi.status === "CREATED") {
      return res.status(409).json({
        error: "A UPI payment QR is currently active for this ticket. Cancel it before closing manually.",
      });
    }
    if (ticket.paymentLink && ticket.paymentLink.status === "CREATED") {
      return res.status(409).json({
        error: "A payment link is currently active for this ticket. Cancel it before closing manually.",
      });
    }

    const { paymentMethod, markUnpaid, exitTime } = req.body;
    const exit = exitTime ? new Date(exitTime) : new Date();

    let feeInfo = { amount: 0, hoursCharged: 0, minutesParked: 0, ratePerHour: 0 };
    if (ticket.paymentStatus !== "PAID") {
      feeInfo = calculateFee(ticket.entryTime, exit);
      ticket.feeAmount = feeInfo.amount;
    }

    const finalPaymentStatus = markUnpaid ? "UNPAID" : "PAID";
    const finalPaymentMethod = markUnpaid
      ? ticket.paymentMethod || "NONE"
      : (ticket.paymentStatus === "PAID" ? ticket.paymentMethod : (paymentMethod || "CASH"));

    await finalizeTicketClose(ticket, {
      paymentStatus: finalPaymentStatus,
      paymentMethod: finalPaymentMethod,
      exitAgentId: req.user.loginId,
      exitAgentName: req.user.name,
      exitTime: exit,
      auditNote: `Verified & handed over. Fee: ${ticket.feeAmount}, payment: ${finalPaymentStatus}`,
    });

    return res.json({ ticket, fee: feeInfo });
  } catch (err) {
    console.error("closeTicket error:", err);
    return res.status(500).json({ error: "Failed to close ticket" });
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/tickets/:id/reopen  — owner-only override
// ---------------------------------------------------------------------------
async function reopenTicket(req, res) {
  try {
    const ticket = await Ticket.findOne({ ticketId: req.params.id });
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    if (ticket.status !== "CLOSED") {
      return res.status(400).json({ error: "Ticket is not closed" });
    }

    ticket.status = "OPEN";
    ticket.deleteAfter = null; // cancel auto-purge until closed again
    ticket.audit.push({
      action: "REOPENED",
      agentId: req.user.loginId,
      agentName: req.user.name,
      note: req.body.reason || "Reopened by owner",
    });

    await ticket.save();
    return res.json({ ticket });
  } catch (err) {
    console.error("reopenTicket error:", err);
    return res.status(500).json({ error: "Failed to reopen ticket" });
  }
}

module.exports = {
  createTicket,
  syncTickets,
  listTickets,
  getTicket,
  updatePayment,
  closeTicket,
  reopenTicket,
  verifyTicketSignature, // re-exported for public route
  finalizeTicketClose, // reused by the Razorpay webhook
  retentionDate,
};
