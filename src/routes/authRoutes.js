const express = require("express");
const router = express.Router();
const { requireAuth, requireRole } = require("../middleware/auth");
const {
  login,
  createAgent,
  listAgents,
  deactivateAgent,
  me,
} = require("../controllers/authController");

router.post("/login", login);
router.get("/me", requireAuth, me);

// Owner/manager manage agent accounts
router.post("/agents", requireAuth, requireRole("owner", "manager"), createAgent);
router.get("/agents", requireAuth, requireRole("owner", "manager"), listAgents);
router.patch("/agents/:id/deactivate", requireAuth, requireRole("owner"), deactivateAgent);

module.exports = router;
