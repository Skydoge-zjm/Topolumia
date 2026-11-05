import test from "node:test";
import assert from "node:assert/strict";
import { localInstant, seriesOccurrence } from "../../src/services/research/record-recurrence.js";
test("monthly recurrence retains original month-end anchor and leap-day behavior", () => {
  const base = { startDate: "2026-01-31", localTime: "14:00", timezone: "Asia/Shanghai", frequency: "monthly", interval: 1 };
  assert.equal(seriesOccurrence(base, 1).date, "2026-02-28"); assert.equal(seriesOccurrence(base, 2).date, "2026-03-31");
  assert.equal(seriesOccurrence({ ...base, startDate: "2028-01-31" }, 1).date, "2028-02-29");
  assert.equal(seriesOccurrence({ ...base, interval: 2 }, 1).date, "2026-03-31");
});
test("recurrence preserves local wall time across daylight saving transitions", () => {
  const base = { startDate: "2026-03-02", localTime: "14:00", timezone: "America/New_York", frequency: "weekly", interval: 1 };
  assert.equal(seriesOccurrence(base, 0).scheduledAt, "2026-03-02T19:00:00.000Z");
  assert.equal(seriesOccurrence(base, 1).scheduledAt, "2026-03-09T18:00:00.000Z");
  assert.throws(() => localInstant("2026-03-08", "02:30", "America/New_York"), { code: "RECORD_LOCAL_TIME_INVALID" });
  assert.throws(() => localInstant("2026-01-01", "14:00", "Invalid/Timezone"), { code: "RECORD_TIMEZONE_INVALID" });
});
