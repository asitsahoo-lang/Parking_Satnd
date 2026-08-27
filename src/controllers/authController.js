const jwt = require("jsonwebtoken");
const User = require("../models/User");

function signToken(user) {
  return jwt.sign(
    {
      id: user._id.toString(),
      loginId: user.loginId,
      name: user.name,
      role: user.role,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "12h" }
  );
}

// POST /api/auth/login  { loginId, pin }
async function login(req, res) {
  try {
    const { loginId, pin } = req.body;
    if (!loginId || !pin) {
      return res.status(400).json({ error: "loginId and pin are required" });
    }

    const user = await User.findOne({ loginId: loginId.toLowerCase(), active: true });
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const ok = await user.comparePin(pin);
    if (!ok) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = signToken(user);
    return res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        loginId: user.loginId,
        role: user.role,
      },
    });
  } catch (err) {
    console.error("login error:", err);
    return res.status(500).json({ error: "Login failed" });
  }
}

// POST /api/auth/agents  (owner/manager only) — create a new agent account
// body: { name, loginId, pin }
async function createAgent(req, res) {
  try {
    const { name, loginId, pin, role } = req.body;
    if (!name || !loginId || !pin) {
      return res.status(400).json({ error: "name, loginId and pin are required" });
    }
    if (pin.length < 4) {
      return res.status(400).json({ error: "PIN must be at least 4 digits" });
    }

    const existing = await User.findOne({ loginId: loginId.toLowerCase() });
    if (existing) {
      return res.status(409).json({ error: "loginId already in use" });
    }

    const pinHash = await User.hashPin(pin);
    const user = await User.create({
      name,
      loginId: loginId.toLowerCase(),
      pinHash,
      role: role === "manager" ? "manager" : "agent", // owner role is not creatable via API
    });

    return res.status(201).json({ user });
  } catch (err) {
    console.error("createAgent error:", err);
    return res.status(500).json({ error: "Failed to create agent" });
  }
}

// GET /api/auth/agents (owner/manager only) — list all staff
async function listAgents(req, res) {
  try {
    const users = await User.find().sort({ createdAt: -1 });
    return res.json({ users });
  } catch (err) {
    console.error("listAgents error:", err);
    return res.status(500).json({ error: "Failed to fetch agents" });
  }
}

// PATCH /api/auth/agents/:id/deactivate (owner only)
async function deactivateAgent(req, res) {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { active: false },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: "User not found" });
    return res.json({ user });
  } catch (err) {
    console.error("deactivateAgent error:", err);
    return res.status(500).json({ error: "Failed to deactivate agent" });
  }
}

// GET /api/auth/me
async function me(req, res) {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  return res.json({ user });
}

module.exports = { login, createAgent, listAgents, deactivateAgent, me };
