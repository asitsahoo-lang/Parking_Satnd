const express = require("express");
const router = express.Router();
const { handleRazorpayWebhook } = require("../controllers/webhookController");

// No requireAuth here — Razorpay isn't a logged-in user. Authenticity is
// verified via HMAC signature inside the handler instead (see app.js for
// the raw-body capture this depends on).
router.post("/razorpay", handleRazorpayWebhook);

module.exports = router;
