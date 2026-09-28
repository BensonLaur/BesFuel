const assert = require("node:assert/strict");
const test = require("node:test");
const { checkMonitors, refreshMonitorDates } = require("../scripts/check-monitors.cjs");

test("an image-only announcement is reported for review without changing the saved price", async () => {
  const data = { regions: { example: { source: { url: "https://official.example.gov.cn/old" },
    grades: { "92": { price: 8.61 } } } } };
  const monitor = { id: "example", allowedHostnames: ["official.example.gov.cn"],
    async collect() { return { url: "https://official.example.gov.cn/new", requiresManualPriceReview: true }; } };
  const [result] = await checkMonitors({ modules: [monitor], data, reader: () => ({}) });
  assert.equal(result.needsReview, true);
  assert.equal(data.regions.example.grades["92"].price, 8.61);
  assert.equal(data.regions.example.source.url, "https://official.example.gov.cn/old");
});

test("a seasonal conversion expiry requires review even without a new announcement", async () => {
  const url = "https://official.example.gov.cn/current";
  const data = { regions: { example: { source: { url } } } };
  const monitor = { id: "example", allowedHostnames: ["official.example.gov.cn"],
    async collect() { return { url, requiresManualCoefficientReview: true }; } };
  const [result] = await checkMonitors({ modules: [monitor], data, reader: () => ({}) });
  assert.equal(result.needsReview, true);
});

test("an in-place correction of an official price table does not refresh an old vetted price", async () => {
  const url = "https://official.example.gov.cn/current";
  const data = { regions: { example: { source: { url }, checkedAt: "2026-09-28",
    grades: { "92": { price: 8.61 }, "95": { price: 9.09 }, diesel: { price: 8.31 } } } } };
  const monitor = { id: "example", allowedHostnames: ["official.example.gov.cn"],
    async collect() { return { url, prices: { "92": 8.62, "95": 9.09, diesel: 8.31 } }; } };
  const [result] = await checkMonitors({ modules: [monitor], data, reader: () => ({}) });
  assert.equal(result.needsReview, true);
  assert.equal(refreshMonitorDates(data, [result], "2026-09-29").count, 0);
  assert.equal(data.regions.example.grades["92"].price, 8.61);
});

test("only unchanged and still-valid manual announcements advance their checked date", () => {
  const data = { checkedAt: "2026-09-28", regions: {
    same: { checkedAt: "2026-09-28" },
    changed: { checkedAt: "2026-09-28" },
    expired: { checkedAt: "2026-09-28" }
  } };
  const results = [
    { id: "same", ok: true, needsReview: false },
    { id: "changed", ok: true, needsReview: true },
    { id: "expired", ok: false, needsReview: true }
  ];
  const refreshed = refreshMonitorDates(data, results, "2026-09-29");
  assert.equal(refreshed.count, 1);
  assert.equal(refreshed.data.regions.same.checkedAt, "2026-09-29");
  assert.equal(refreshed.data.regions.changed.checkedAt, "2026-09-28");
  assert.equal(refreshed.data.regions.expired.checkedAt, "2026-09-28");
  assert.equal(data.regions.same.checkedAt, "2026-09-28");
});
