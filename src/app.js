const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

const authRoutes = require("./routes/authRoutes");
const ticketRoutes = require("./routes/ticketRoutes");
const dashboardRoutes = require("./routes/dashboardRoutes");
const publicRoutes = require("./routes/publicRoutes");
const webhookRoutes = require("./routes/webhookRoutes");
const { ticketPage } = require("./controllers/publicController");

const app = express();

// ---- Core middleware ----
app.use(helmet());
app.use(cors()); // Flutter app calls from mobile, so open CORS is fine; tighten if you add a web client
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// Photos are sent as base64 — allow a generous body size.
// The `verify` callback stashes the exact raw bytes on req.rawBody BEFORE
// JSON parsing — required by the Razorpay webhook to verify its HMAC
// signature, since that signature is computed over the raw payload, not
// the re-serialized parsed object (which can differ in whitespace/key
// order and would make every signature check fail).
app.use(
  express.json({
    limit: "15mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

// Basic rate limiting on auth to slow down PIN brute-forcing
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Too many login attempts, please try again later." },
});
app.use("/api/auth/login", loginLimiter);

// ---- Health check ----
app.get("/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---- API routes ----
app.use("/api/auth", authRoutes);
app.use("/api/tickets", ticketRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/webhooks", webhookRoutes);

// ---- Customer-facing QR landing page (no separate site — served right here) ----
app.get("/t/:id", ticketPage);

// ---- 404 ----
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ---- Error handler ----
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

module.exports = app;
