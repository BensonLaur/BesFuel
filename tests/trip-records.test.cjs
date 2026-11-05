"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const records = require("../lib/trip-records.js");
const input = () => ({ distance: "7", consumption: "11.9", price: "8.91", region: "广东", grade: "92 号汽油" });
const make = (id = "trip-1", optional = {}) => records.createRecord(input(), optional, { id, now: new Date("2026-11-06T01:23:45.000Z") });
function storage() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}

test("trip records freeze exact inputs and unrounded costs with optional duration", () => {
  const original = input(), record = records.createRecord(original, { minutes: "35.5", note: " 上班 · 沿江路 " },
    { id: "trip-1", now: new Date("2026-11-06T01:23:45.000Z") });
  original.price = "99";
  assert.equal(record.price, 8.91);
  assert.equal(record.total.toFixed(2), "7.42");
  assert.equal(record.perKm, 11.9 * 8.91 / 100);
  assert.equal(record.minutes, 35.5);
  assert.equal(record.note, "上班 · 沿江路");
  assert.equal(record.createdAt, "2026-11-06T01:23:45.000Z");
  assert.equal(make().minutes, null);
  assert.throws(() => make("bad", { minutes: "0" }), /分钟/);
  for (const minutes of ["-1", "Infinity", "bad"]) assert.throws(() => make("bad", { minutes }), /分钟/);
  assert.throws(() => records.createRecord({ ...input(), distance: "" }), /里程/);
  assert.throws(() => make("bad", { note: "x".repeat(61) }), /60/);
});

test("fresh reads preserve other tabs' additions/deletions and undo restores the original timestamp", () => {
  const store = storage(), first = make(), second = { ...make("trip-2"), createdAt: "2026-11-06T02:00:00.000Z" };
  assert.deepEqual(records.readRecords(store), []);
  records.addRecord(store, first);
  const stale = records.readRecords(store);
  records.addRecord(store, second);
  assert.equal(stale.length, 1);
  assert.deepEqual(records.removeRecord(store, first.id), [second]);
  assert.deepEqual(records.addRecord(store, first), [second, first]);
  assert.throws(() => records.addRecord(store, first), /已存在/);
  assert.deepEqual(records.removeRecord(store, "not-present"), [second, first]);
  records.removeRecord(store, second.id);
  assert.deepEqual(records.removeRecord(store, first.id), []);
  assert.deepEqual(records.readRecords(store), []);
});

test("quota failures keep every previously saved trip intact", () => {
  const store = storage();
  records.addRecord(store, make());
  const before = store.getItem(records.storageKey);
  store.setItem = () => { throw new Error("QuotaExceededError"); };
  assert.throws(() => records.addRecord(store, make("trip-2")), /Quota/);
  assert.throws(() => records.removeRecord(store, "trip-1"), /Quota/);
  assert.equal(store.getItem(records.storageKey), before);
  assert.equal(records.readRecords(store).length, 1);
});

test("unreadable or inconsistent stored data is never overwritten by a later save", () => {
  for (const raw of ["broken JSON", JSON.stringify({ version: 2, records: [] }),
    JSON.stringify({ version: 1, records: [{ ...make(), total: 0 }] }),
    JSON.stringify({ version: 1, records: [{ ...make(), minutes: -1 }] }),
    JSON.stringify({ version: 1, records: [make(), make()] })]) {
    const store = storage();
    store.setItem(records.storageKey, raw);
    assert.throws(() => records.addRecord(store, make("new")));
    assert.throws(() => records.removeRecord(store, "trip-1"));
    assert.equal(store.getItem(records.storageKey), raw);
  }
});
