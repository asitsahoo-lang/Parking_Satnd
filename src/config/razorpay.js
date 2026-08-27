const Razorpay = require("razorpay");

let client = null;

function getRazorpayClient() {
  if (client) return client;

  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    throw new Error("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set in .env");
  }

  client = new Razorpay({ key_id: keyId, key_secret: keySecret });
  return client;
}

module.exports = { getRazorpayClient };
