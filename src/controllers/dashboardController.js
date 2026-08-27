const Ticket = require("../models/Ticket");

// ---------------------------------------------------------------------------
// GET /api/dashboard
// query: ?from=ISODate&to=ISODate  (defaults to today)
// Aggregate view for the owner: totals, revenue, per-agent breakdown, sync
// status snapshot. Rendered natively in Flutter via fl_chart — this endpoint
// just returns numbers.
// ---------------------------------------------------------------------------
async function getDashboard(req, res) {
  try {
    const { from, to } = req.query;

    const start = from ? new Date(from) : new Date(new Date().setHours(0, 0, 0, 0));
    const end = to ? new Date(to) : new Date();

    const dateFilter = { entryTime: { $gte: start, $lte: end } };

    const [totalVehicles, open, closed, paid, pending, unpaid, revenueAgg, perAgent] = await Promise.all([
      Ticket.countDocuments(dateFilter),
      Ticket.countDocuments({ ...dateFilter, status: "OPEN" }),
      Ticket.countDocuments({ ...dateFilter, status: "CLOSED" }),
      Ticket.countDocuments({ ...dateFilter, paymentStatus: "PAID" }),
      Ticket.countDocuments({ ...dateFilter, paymentStatus: "PENDING" }),
      Ticket.countDocuments({ ...dateFilter, paymentStatus: "UNPAID" }),
      Ticket.aggregate([
        { $match: { ...dateFilter, paymentStatus: "PAID" } },
        { $group: { _id: null, total: { $sum: "$feeAmount" } } },
      ]),
      Ticket.aggregate([
        { $match: dateFilter },
        {
          $group: {
            _id: "$entryAgentId",
            agentName: { $first: "$entryAgentName" },
            vehiclesHandled: { $sum: 1 },
            revenueCollected: {
              $sum: { $cond: [{ $eq: ["$paymentStatus", "PAID"] }, "$feeAmount", 0] },
            },
          },
        },
        { $sort: { vehiclesHandled: -1 } },
      ]),
    ]);

    const revenue = revenueAgg[0]?.total || 0;

    return res.json({
      range: { from: start, to: end },
      totals: {
        totalVehicles,
        open,
        closed,
        paid,
        pending,
        unpaid,
        revenue,
      },
      perAgent,
    });
  } catch (err) {
    console.error("getDashboard error:", err);
    return res.status(500).json({ error: "Failed to build dashboard" });
  }
}

// ---------------------------------------------------------------------------
// GET /api/dashboard/audit/:ticketId — full audit trail for one ticket
// ---------------------------------------------------------------------------
async function getTicketAudit(req, res) {
  try {
    const ticket = await Ticket.findOne({ ticketId: req.params.ticketId }).select("ticketId plateNumber audit");
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    return res.json({ ticketId: ticket.ticketId, plateNumber: ticket.plateNumber, audit: ticket.audit });
  } catch (err) {
    console.error("getTicketAudit error:", err);
    return res.status(500).json({ error: "Failed to fetch audit trail" });
  }
}

module.exports = { getDashboard, getTicketAudit };
