const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { validateSnapshot, validateFiles } = require("./validate-data.cjs");

const root = path.resolve(__dirname, "..");
const sourceDirectory = path.join(__dirname, "sources");
const dataDirectory = path.join(root, "data");
const jsonPath = path.join(dataDirectory, "prices.json");
const scriptPath = path.join(dataDirectory, "prices.js");
const grades = ["92", "95", "diesel"];

function chinaDate(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function officialUrl(value, hosts) {
  let url;
  try { url = new URL(value); } catch (_) { return false; }
  return ["http:", "https:"].includes(url.protocol) && hosts.includes(url.hostname) &&
    !url.username && !url.password;
}

function makeReader(hosts) {
  const cache = new Map();
  async function getBuffer(url, depth = 0) {
    if (!officialUrl(url, hosts)) throw new Error(`非允许的官方地址：${url}`);
    if (depth > 3) throw new Error(`重定向过多：${url}`);
    if (!cache.has(url)) cache.set(url, (async () => {
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = new URL(response.headers.get("location"), url).href;
        return getBuffer(next, depth + 1);
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}：${url}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > 5_000_000) throw new Error(`官方文件过大：${url}`);
      return { buffer, contentType: response.headers.get("content-type") || "", url };
    })());
    return cache.get(url);
  }
  async function getText(url) {
    const response = await getBuffer(url);
    const prefix = response.buffer.subarray(0, 4096).toString("latin1");
    const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(response.contentType)?.[1] ||
      /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(prefix)?.[1] || "utf-8";
    return new TextDecoder(charset).decode(response.buffer);
  }
  return { getText, getBuffer };
}

function validateNotices(source, notices, today) {
  assert.ok(source && typeof source.id === "string" && /^[a-z][a-z0-9-]*$/.test(source.id), "source id");
  assert.ok(source.name && source.sourceName && source.priceScope, `${source.id}: labels`);
  assert.ok(Array.isArray(source.allowedHostnames) && source.allowedHostnames.length, `${source.id}: official hosts`);
  assert.ok(Array.isArray(notices) && notices.length, `${source.id}: no verified notices`);
  let previous = "";
  for (const notice of notices) {
    assert.ok(validDate(notice.publishedDate) && validDate(notice.effectiveDate) &&
      notice.effectiveDate > notice.publishedDate && notice.effectiveDate <= today &&
      notice.effectiveDate > previous, `${source.id}: effective dates`);
    assert.ok(officialUrl(notice.url, source.allowedHostnames), `${source.id}: official notice URL`);
    for (const grade of grades) {
      const price = notice.prices?.[grade];
      assert.ok(Number.isFinite(price) && price >= 1 && price <= 30 &&
        Math.abs(Math.round(price * 100) - price * 100) < 1e-8, `${source.id}/${grade}: yuan per liter`);
    }
    previous = notice.effectiveDate;
  }
  return notices;
}

function mergeRegion(data, source, notices, today, hostOverrides = {}) {
  validateNotices(source, notices, today);
  const latest = notices.at(-1);
  const prior = data.regions[source.id];
  const priorLatest = prior?.grades?.["92"]?.history?.at(-1);
  if (priorLatest && latest.effectiveDate < priorLatest.date) {
    throw new Error(`${source.id}: 官方列表比已保存的可信价格旧`);
  }
  const region = prior || {
    name: source.name, priceScope: source.priceScope, checkedAt: today,
    source: { name: source.sourceName, url: latest.url },
    effectiveLabel: `${latest.publishedDate} 24:00 起`, grades: {}
  };
  for (const grade of grades) {
    const existing = region.grades[grade]?.history || [];
    const history = new Map(existing.map(point => [point.date, point]));
    for (const notice of notices) {
      const old = history.get(notice.effectiveDate);
      if (old && old.price !== notice.prices[grade]) {
        throw new Error(`${source.id}/${grade}: 同日官方价格与旧快照冲突`);
      }
      // Mirrored notices can have different official URLs; keep the original audited link.
      if (!old) history.set(notice.effectiveDate, {
        date: notice.effectiveDate, price: notice.prices[grade], sourceUrl: notice.url
      });
    }
    region.grades[grade] = {
      price: latest.prices[grade],
      history: [...history.values()].sort((a, b) => a.date.localeCompare(b.date))
    };
  }
  region.grades["98"] ||= { price: null, history: [] };
  region.name = source.name;
  region.priceScope = source.priceScope;
  region.checkedAt = today;
  region.source = { name: source.sourceName, url: latest.url };
  region.effectiveLabel = `${latest.publishedDate} 24:00 起`;
  if (source.conversion?.validThrough) {
    region.priceValidThrough = source.conversion.validThrough;
    region.conversionSource = {
      url: source.conversion.url,
      ruleUrl: source.conversion.ruleUrl,
      validThrough: source.conversion.validThrough
    };
  } else {
    delete region.priceValidThrough;
    delete region.conversionSource;
  }
  data.regions[source.id] = region;
  if (today > data.checkedAt) data.checkedAt = today;
  validateSnapshot(data, { ...hostOverrides, [source.id]: source.allowedHostnames });
  return data;
}

function crlf(value) { return value.replace(/\r\n|\r|\n/g, "\n").trimEnd().replace(/\n/g, "\r\n") + "\r\n"; }

function writeSnapshot(data, outputJson = jsonPath, outputScript = scriptPath) {
  const json = crlf(JSON.stringify(data, null, 2));
  const script = crlf(`// Generated from data/prices.json; do not edit directly.\nwindow.BESFUEL_DATA = ${JSON.stringify(data, null, 2)};`);
  const temporaryJson = `${outputJson}.tmp`;
  const temporaryScript = `${outputScript}.tmp`;
  try {
    fs.writeFileSync(temporaryJson, json, "utf8");
    fs.writeFileSync(temporaryScript, script, "utf8");
    validateFiles(temporaryJson, temporaryScript);
    fs.renameSync(temporaryJson, outputJson);
    fs.renameSync(temporaryScript, outputScript);
  } finally {
    for (const file of [temporaryJson, temporaryScript]) {
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    }
  }
}

async function updateAll({ sources, initial, today = chinaDate(), reader = makeReader } = {}) {
  const data = structuredClone(initial || JSON.parse(fs.readFileSync(jsonPath, "utf8")));
  const modules = sources || (fs.existsSync(sourceDirectory) ?
    fs.readdirSync(sourceDirectory).filter(name => name.endsWith(".cjs")).sort()
      .map(name => require(path.join(sourceDirectory, name))) : []);
  const hostOverrides = Object.fromEntries(modules.map(source => [source.id, source.allowedHostnames]));
  const results = [];
  for (const source of modules) {
    try {
      const next = structuredClone(data);
      const notices = await source.collect({ ...reader(source.allowedHostnames), today });
      mergeRegion(next, source, notices, today, hostOverrides);
      Object.assign(data, next);
      results.push({ id: source.id, ok: true, count: notices.length });
    } catch (error) {
      results.push({ id: source.id, ok: false, error: error.message });
    }
  }
  return { data, results };
}

if (require.main === module) {
  updateAll().then(({ data, results }) => {
    if (results.some(result => result.ok)) writeSnapshot(data);
    for (const result of results) console.log(result.ok ?
      `${result.id}: 核对 ${result.count} 条官方公告` : `${result.id}: 保留旧数据；${result.error}`);
    // Each source is independent: one unavailable site must not block other prices or Pages.
  }).catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { chinaDate, officialUrl, makeReader, validateNotices, mergeRegion, updateAll, writeSnapshot };
