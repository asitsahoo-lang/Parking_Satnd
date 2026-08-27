const express = require("express");
const router = express.Router();
const { requireAuth, requireRole } = require("../middleware/auth");
const {
  createTicket,
  syncTickets,
  listTickets,
  getTicket,
  updatePayment,
  closeTicket,
  reopenTicket,
} = require("../controllers/ticketController");
const { createUpiQr, getUpiStatus, cancelUpiQr } = require("../controllers/paymentController");

// All ticket routes require a logged-in agent/owner
router.use(requireAuth);

router.post("/", createTicket);
router.post("/sync", syncTickets);
router.get("/", listTickets);
router.get("/:id", getTicket);
router.patch("/:id/payment", updatePayment);
router.patch("/:id/close", closeTicket);
router.patch("/:id/reopen", requireRole("owner", "manager"), reopenTicket);

// ---- Real-time UPI payment (Razorpay) ----
router.post("/:id/upi/create", createUpiQr);
router.get("/:id/upi/status", getUpiStatus);
router.patch("/:id/upi/cancel", cancelUpiQr);

module.exports = router;
