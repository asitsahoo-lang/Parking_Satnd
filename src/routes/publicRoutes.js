const express = require("express");
const router = express.Router();
const { verifyQr } = require("../controllers/publicController");

// Signature verification, JSON — used by agent app or anyone double-checking a QR
router.get("/verify/:id", verifyQr);

module.exports = router;
