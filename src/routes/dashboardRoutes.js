const express = require("express");
const router = express.Router();
const { requireAuth, requireRole } = require("../middleware/auth");
const { getDashboard, getTicketAudit } = require("../controllers/dashboardController");

router.use(requireAuth, requireRole("owner", "manager"));

router.get("/", getDashboard);
router.get("/audit/:ticketId", getTicketAudit);

module.exports = router;
