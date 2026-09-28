const assert = require("node:assert/strict");
const test = require("node:test");
const { calculate, parseNonNegative } = require("../lib/calc.js");

test("9 公里、9 升/百公里、8.63 元/升", () => {
  const result = calculate("9", "9", "8.63");
  assert.equal(result.perKm.toFixed(2), "0.78");
  assert.equal(result.total.toFixed(2), "6.99");
});

test("未填里程时仍显示每公里油费", () => {
  assert.deepEqual(calculate("", "8", "9"), { perKm: .72, total: null });
});

test("拒绝空值、负数和非有限数字", () => {
  for (const value of ["", "-1", "Infinity", "abc"]) assert.equal(parseNonNegative(value), null);
  assert.deepEqual(calculate("10", "-1", "8"), { perKm: null, total: null });
  const zeroDistance = calculate("0", "9", "8.63");
  assert.equal(zeroDistance.perKm.toFixed(2), "0.78");
  assert.equal(zeroDistance.total, 0);
  assert.deepEqual(calculate("10", "1e308", "1e308"), { perKm: null, total: null });
});
