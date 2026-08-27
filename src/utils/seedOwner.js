// Run with: npm run seed:owner
// Creates (or updates) the single Owner account using SEED_OWNER_NAME /
// SEED_OWNER_PIN from .env. Run this once after your DB is connected.

require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/User");

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB for seeding...");

  const name = process.env.SEED_OWNER_NAME || "Owner";
  const pin = process.env.SEED_OWNER_PIN || "1234";
  const loginId = "owner";

  const pinHash = await User.hashPin(pin);

  const owner = await User.findOneAndUpdate(
    { loginId },
    { name, loginId, pinHash, role: "owner", active: true },
    { upsert: true, new: true }
  );

  console.log("Owner account ready:");
  console.log(`  loginId: ${owner.loginId}`);
  console.log(`  pin:     ${pin}  (change this after first login!)`);
  console.log(`  role:    ${owner.role}`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
