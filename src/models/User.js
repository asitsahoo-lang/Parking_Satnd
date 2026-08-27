const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema(
  {
    // Human-readable name shown on tickets / dashboard ("Ravi", "Owner")
    name: {
      type: String,
      required: true,
      trim: true,
    },
    // Unique login identifier — e.g. a short agent code (AGT01) chosen at creation.
    // Kept separate from PIN so two agents can't collide on a shared PIN.
    loginId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    // Hashed PIN — never store plain text
    pinHash: {
      type: String,
      required: true,
    },
    role: {
      type: String,
      enum: ["agent", "owner", "manager"],
      default: "agent",
    },
    active: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

userSchema.methods.comparePin = async function (candidatePin) {
  return bcrypt.compare(candidatePin, this.pinHash);
};

userSchema.statics.hashPin = async function (pin) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(pin, salt);
};

// Never leak the hash in API responses
userSchema.set("toJSON", {
  transform: (_doc, ret) => {
    delete ret.pinHash;
    return ret;
  },
});

module.exports = mongoose.model("User", userSchema);
