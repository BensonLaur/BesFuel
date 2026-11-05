(function (root) {
  "use strict";
  const calc = root.BesFuelCalc || require("./calc.js");
  const storageKey = "besfuel-trip-records-v1";
  const text = (value, limit) => typeof value === "string" && value.length <= limit;

  function createRecord(input, { minutes = "", note = "" } = {}, { id, now = new Date() } = {}) {
    const distance = calc.parseNonNegative(input.distance);
    const consumption = calc.parseNonNegative(input.consumption);
    const price = calc.parseNonNegative(input.price);
    const result = calc.calculate(distance, consumption, price);
    if (result.total === null) throw new Error("请先填写有效的里程、平均油耗和油价。");
    const duration = String(minutes).trim() === "" ? null : Number(minutes);
    if (duration !== null && (!Number.isFinite(duration) || duration <= 0)) throw new Error("耗时请输入大于 0 的分钟数，或留空。");
    if (!text(note, 60)) throw new Error("行程备注请控制在 60 字以内。");
    if (!text(input.region, 100) || !text(input.grade, 40)) throw new Error("行程地区或油号无效。");
    return { id: id || root.crypto?.randomUUID?.() || `trip-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      createdAt: now.toISOString(), distance, consumption, price, perKm: result.perKm, total: result.total,
      minutes: duration, note: note.trim(), region: input.region, grade: input.grade };
  }

  function validate(record) {
    if (!record || !text(record.id, 100) || !record.id || !text(record.createdAt, 40) ||
        !Number.isFinite(Date.parse(record.createdAt)) || new Date(record.createdAt).toISOString() !== record.createdAt ||
        ![record.distance, record.consumption, record.price].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0) ||
        !(record.minutes === null || typeof record.minutes === "number" && Number.isFinite(record.minutes) && record.minutes > 0) ||
        !text(record.note, 60) || !text(record.region, 100) || !text(record.grade, 40)) throw new Error("记录格式无效");
    const result = calc.calculate(record.distance, record.consumption, record.price);
    if (result.total === null || result.perKm !== record.perKm || result.total !== record.total) throw new Error("记录金额与输入不一致");
  }

  function readRecords(storage) {
    const raw = storage.getItem(storageKey);
    if (raw === null) return [];
    const value = JSON.parse(raw);
    if (value?.version !== 1 || !Array.isArray(value.records)) throw new Error("记录格式无效");
    value.records.forEach(validate);
    if (new Set(value.records.map(record => record.id)).size !== value.records.length) throw new Error("记录编号重复");
    return value.records;
  }

  function addRecord(storage, record) {
    validate(record);
    // Read at write time to preserve changes another tab has already saved.
    const current = readRecords(storage);
    if (current.some(item => item.id === record.id)) throw new Error("这条记录已存在。");
    const next = [record, ...current].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    // Never evict older trips to make space; a quota failure leaves them intact.
    storage.setItem(storageKey, JSON.stringify({ version: 1, records: next }));
    return next;
  }

  function removeRecord(storage, id) {
    const current = readRecords(storage);
    const next = current.filter(record => record.id !== id);
    if (next.length !== current.length) storage.setItem(storageKey, JSON.stringify({ version: 1, records: next }));
    return next;
  }

  const api = { storageKey, createRecord, readRecords, addRecord, removeRecord };
  root.BesFuelTripRecords = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
