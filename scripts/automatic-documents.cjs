"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { GROUPS, decodeDocument, validateEvidence } = require("./cloud-evidence.cjs");
const { mergeRegion, chinaDate } = require("./update-regions.cjs");
const { failureResult } = require("./source-errors.cjs");
const { validateSnapshot } = require("./validate-data.cjs");
const compact = html => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
  .replace(/<[^>]*>/g, "").replace(/&(?:nbsp|ensp|emsp);|&#160;|\s/g, "");
const dayText = day => day.split("-").map(Number).map((v, i) => v + ["年", "月", "日"][i]).join("");
const nextDay = day => new Date(Date.parse(day + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
function parseXizang(html, latest) {
  const text = compact(html), day = latest.publishedDate;
  assert.ok(text.includes("西藏自治区成品油销售价格调整通知") &&
    text.includes(`我区成品油销售价格自${dayText(day)}24时起同步调整`) &&
    text.includes("此次") && text.includes("最高零售价格") &&
    text.includes(`西藏自治区发展和改革委员会${dayText(day)}`), "西藏公告标题、生效日或零售口径异常");
  const starts = ["（一）拉萨价区（包括拉萨、日喀则、山南、林芝、那曲）", "（二）昌都价区", "（三）阿里价区", "二、根据国家"];
  const positions = starts.map(token => text.indexOf(token));
  assert.ok(positions.every((position, i) => position >= 0 && (!i || position > positions[i - 1])), "西藏价区分段变化");
  const results = {};
  for (let i = 0; i < 3; i++) {
    const section = text.slice(positions[i], positions[i + 1]), prices = {}, previous = {};
    for (const [grade, label] of [["92", "92号汽油"], ["95", "95号汽油"], ["diesel", "0号柴油"]]) {
      const pattern = new RegExp(`(?:^|[。）]|价区)${label}每吨由[\\d,.]+元(?:上调|下调)为[\\d,.]+元，每升由(\\d{1,2}\\.\\d{2})元(上调|下调)为(\\d{1,2}\\.\\d{2})元，每升(涨|降)(\\d{1,2}\\.\\d{2})元`, "g");
      const matches = [...section.matchAll(pattern)];
      assert.equal(matches.length, 1, `西藏 ${grade} 升价不唯一或缺失`);
      const [, old, direction, current, change, delta] = matches[0];
      const difference = Math.round(Number(current) * 100) - Math.round(Number(old) * 100);
      assert.ok((direction === "上调" ? change === "涨" && difference > 0 : change === "降" && difference < 0) &&
        Math.abs(difference) === Math.round(Number(delta) * 100), "西藏新旧价格与涨跌额不一致");
      prices[grade] = Number(current); previous[grade] = Number(old);
    }
    results[GROUPS.xizang[i]] = { prices, previous };
  }
  return results;
}
function parseZhejiang(html, latest) {
  const text = compact(html), day = latest.publishedDate;
  assert.ok(/^浙江省成品油价格(?:按机制)?(?:调整|上调|下调|不作调整)$/.test(latest.title), "浙江公告类型异常");
  assert.ok(html.includes(`content="${latest.title}"`) &&
    html.includes(`content="${day} `) && html.includes('content="价格处"') &&
    text.includes(`浙江省发展和改革委员会${dayText(day)}`), "浙江公告标题、日期或来源不符");
  if (latest.kind === "unchanged") {
    assert.ok(latest.title === "浙江省成品油价格不作调整" && text.includes("本次汽、柴油价格不作调整"), "浙江不调整结论缺失");
    const reference = [...text.matchAll(/自(\d{4})年(\d{1,2})月(\d{1,2})日国内成品油价格调整以来/g)];
    assert.equal(reference.length, 1, "浙江不调整公告未明确对应上次调价");
    return { unchanged: `${reference[0][1]}-${reference[0][2].padStart(2, "0")}-${reference[0][3].padStart(2, "0")}` };
  }
  assert.ok(new RegExp(`(?:${day.slice(0, 4)}年)?${Number(day.slice(5, 7))}月${Number(day.slice(8))}日24时起`).test(text), "浙江调价生效日不符");
  const tables = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].map(table =>
    [...table[0].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(row =>
      [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => compact(cell[1]))));
  const matches = tables.filter(table => table[0]?.join("|") === "品种|型号|零售价|批发价" && table[1]?.join("|") === "元/吨|元/升|元/吨");
  assert.equal(matches.length, 1, "浙江元/升零售价表不唯一");
  const prices = {};
  for (const [grade, pattern] of [["92", /^92号[（(](?:ⅥB|VIB)[）)]$/], ["95", /^95号[（(](?:ⅥB|VIB)[）)]$/], ["diesel", /^0号[（(]Ⅵ[）)]$/]]) {
    const rows = matches[0].slice(2).filter(row => pattern.test(row[1]));
    assert.ok(rows.length === 1 && rows[0].length === 5 && /^\d{1,2}\.\d{2}$/.test(rows[0][3]), `浙江 ${grade} 价格缺失`);
    prices[grade] = Number(rows[0][3]);
  }
  assert.deepEqual(prices, latest.prices, "浙江附件与公告监测价格冲突");
  return { prices };
}
async function parseBinary(group, document, latest, execute = promisify(execFile)) {
  const buffer = decodeDocument(document), extension = group === "sichuan" ? ".docx" : ".pdf";
  assert.ok(group === "sichuan" ? buffer.subarray(0, 2).toString() === "PK" : buffer.subarray(0, 5).toString() === "%PDF-", "附件文件类型不符");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "besfuel-table-")), file = path.join(directory, "official" + extension);
  try {
    fs.writeFileSync(file, buffer);
    let result;
    try {
      result = await execute(process.env.BESFUEL_PYTHON || "python", [path.join(__dirname, "read-price-document.py"), group, file, latest.publishedDate],
        { windowsHide: true, timeout: 30000, maxBuffer: 20000, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    } catch (error) {
      // Temporary file names change on every run; they must not become new alerts.
      throw new Error(`${group}: 附件解析未通过：${String(error.stderr || error.code || error.name).replaceAll(directory, "<temp>").trim()}`);
    }
    const prices = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(prices).sort(), [...GROUPS[group]].sort(), "附件价区清单异常");
    return prices;
  } finally { if (fs.existsSync(file)) fs.unlinkSync(file); fs.rmdirSync(directory); }
}
function acceptDocument(initial, id, latest, parsed, today) {
  const data = structuredClone(initial), old = data.regions[id], record = require(`../data/verified/${id}.json`);
  assert.ok(old && old.checkedAt <= today, "附件核对日期回退");
  if (parsed.unchanged) {
    assert.ok(parsed.unchanged <= latest.publishedDate && latest.publishedDate <= today &&
      Object.values(old.grades).filter(grade => grade.price !== null).every(grade => grade.history.at(-1)?.date === nextDay(parsed.unchanged)),
    "不调整公告与此前可信价表不对应，需补齐历史");
    assert.ok(!old.latestNotice || old.latestNotice.date <= latest.publishedDate, "不调整公告日期回退");
    old.latestNotice = { kind: "unchanged", date: latest.publishedDate, title: latest.title, sourceUrl: latest.url, priceSourceUrl: old.source.url };
    old.checkedAt = today;
    if (data.checkedAt < today) data.checkedAt = today;
    validateSnapshot(data);
    return data;
  }
  const date = latest.effectiveDate || nextDay(latest.publishedDate);
  // Check the pre-run date, not the date refreshed by announcement monitoring.
  assert.ok(Date.parse(latest.publishedDate) - Date.parse(old.checkedAt) <= 3 * 86400000, "公告检查中断，需补齐期间历史");
  if (parsed.previous && date > old.grades["92"].history.at(-1).date) {
    for (const grade of ["92", "95", "diesel"]) assert.equal(parsed.previous[grade], old.grades[grade].price, "西藏公告中的调整前价格与旧快照冲突");
  }
  mergeRegion(data, record, [{ ...latest, effectiveDate: date, prices: parsed.prices }], today);
  return data;
}
async function applyDocuments(bundle, initial, current, monitors, { parse = parseBinary } = {}) {
  const evidence = validateEvidence(bundle);
  if (!evidence) return { data: current, monitors }; // Old FC stays valid until the one-time code upload.
  let data = current;
  const results = monitors.map(item => structuredClone(item)), today = chinaDate(new Date(bundle.startedAt));
  for (const [group, ids] of Object.entries(GROUPS)) {
    const relay = evidence.get(group), first = bundle.monitors.find(item => item.id === ids[0]);
    const failed = (id, error) => {
      const result = failureResult(id, error);
      result.failure.url ||= first?.latest?.url || "";
      if (relay.ok) result.evidenceFingerprint = crypto.createHash("sha256").update(relay.documents.map(d => d.sha256).join("\n")).digest("hex");
      return { ...result, automatic: false };
    };
    try {
      if (!relay.ok) throw Object.assign(new Error(relay.error), { details: relay.failure });
      const parsed = group === "xizang" ? parseXizang(decodeDocument(relay.documents[0]).toString("utf8"), first.latest) :
        group === "zhejiang" ? { zhejiang: parseZhejiang(decodeDocument(relay.documents[0]).toString("utf8"), first.latest) } :
        Object.fromEntries(Object.entries(await parse(group, relay.documents[1], first.latest)).map(([id, prices]) => [id, { prices }]));
      for (const id of ids) {
        const result = results.find(item => item.id === id), latest = bundle.monitors.find(item => item.id === id).latest;
        try {
          const accepted = acceptDocument(initial, id, latest, parsed[id], today);
          data.regions[id] = accepted.regions[id];
          if (data.checkedAt < accepted.checkedAt) data.checkedAt = accepted.checkedAt;
          Object.assign(result, { ok: true, needsReview: false, automatic: true, transport: "FC", evidence: relay.documents.map(({ url, sha256 }) => ({ url, sha256 })) });
        } catch (error) {
          data.regions[id] = structuredClone(initial.regions[id]);
          Object.assign(result, failed(id, error));
        }
      }
    } catch (error) {
      for (const id of ids) {
        data.regions[id] = structuredClone(initial.regions[id]);
        Object.assign(results.find(item => item.id === id), failed(id, error));
      }
    }
  }
  validateSnapshot(data);
  return { data, monitors: results };
}
module.exports = { parseXizang, parseZhejiang, parseBinary, acceptDocument, applyDocuments };
