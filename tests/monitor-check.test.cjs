const assert = require("node:assert/strict");
const test = require("node:test");
const { checkMonitors } = require("../scripts/check-monitors.cjs");

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
