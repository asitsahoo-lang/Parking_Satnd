/**
 * Auto fee calculation — no manual typing/skimming.
 *
 * Default rule (configurable via .env): hourly rate, rounded UP to the next
 * hour, with an optional grace period before the next hour's charge kicks in.
 *
 * Example with RATE_PER_HOUR=20, MIN_CHARGE_HOURS=1, GRACE_MINUTES=10:
 *   0h05m parked -> 1 hour charged  -> ₹20
 *   1h05m parked -> 1 hour charged  -> ₹20   (within 10 min grace of hour 2)
 *   1h15m parked -> 2 hours charged -> ₹40
 */
function calculateFee(entryTime, exitTime) {
  const rate = Number(process.env.RATE_PER_HOUR || 20);
  const minHours = Number(process.env.MIN_CHARGE_HOURS || 1);
  const graceMinutes = Number(process.env.GRACE_MINUTES || 0);

  const entry = new Date(entryTime).getTime();
  const exit = new Date(exitTime).getTime();

  if (isNaN(entry) || isNaN(exit) || exit < entry) {
    throw new Error("Invalid entry/exit time for fee calculation");
  }

  const minutesParked = (exit - entry) / (1000 * 60);
  const graceAdjustedMinutes = Math.max(0, minutesParked - graceMinutes);

  let hoursCharged = Math.ceil(graceAdjustedMinutes / 60);
  if (hoursCharged < minHours) hoursCharged = minHours;

  const amount = hoursCharged * rate;

  return {
    minutesParked: Math.round(minutesParked),
    hoursCharged,
    ratePerHour: rate,
    amount,
  };
}

module.exports = { calculateFee };
