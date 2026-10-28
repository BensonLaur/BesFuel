const fs = require("node:fs");
const assert = require("node:assert/strict");
const { chinaToday, isValidDate } = require("./date-utils.cjs");
const { failureResult, requestError } = require("./source-errors.cjs");

const homeUrl = "https://www.tuanyou.net/youjia/";
const articleBase = "https://www.tuanyou.net";

function parseHome(html, expectedWindow, today) {
  if (!isValidDate(expectedWindow) || !isValidDate(today)) throw new Error("invalid forecast dates");
  const heading = html.indexOf("下轮油价预测");
  const start = html.lastIndexOf("<table", heading);
  const end = html.indexOf("</table>", heading);
  if (heading < 0 || start < 0 || end < 0) throw new Error("forecast table missing");
  const table = html.slice(start, end + 8);
  const plain = table.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  const row = plain.match(/(-?\d+(?:\.\d+)?)%\s*(涨|降)(\d+(?:\.\d{1,2})?)元\/升\s*(\d{1,2})\s*(\d{4})年(\d{1,2})月(\d{1,2})日/);
  const link = table.match(/href="(\/yuanyou\/bianhualv\/\d+\.html)"[^>]*>\s*\d{4}年/);
  const window = html.match(/下次调价：\s*(\d{4}-\d{2}-\d{2})/);
  if (!row || !link || !window || window[1] !== expectedWindow) throw new Error("forecast fields do not match the next window");
  const updatedAt = `${row[5]}-${row[6].padStart(2, "0")}-${row[7].padStart(2, "0")}`;
  const amount = Number(row[3]);
  const workday = Number(row[4]);
  // Holidays can leave the current cycle's latest estimate older than two days.
  // Its calculation date stays unchanged so the page can mark it as stale.
  if (!isValidDate(updatedAt) || updatedAt > today || updatedAt > expectedWindow || expectedWindow < today ||
      amount <= 0 || amount > 5 || workday < 1 || workday > 10) {
    throw new Error("forecast dates or values are outside safe bounds");
  }
  return {
    direction: row[2] === "涨" ? "up" : "down",
    amountPerLiter: amount,
    description: `预计${row[2] === "涨" ? "上调" : "下调"}约 ${amount.toFixed(2)} 元/升`,
    sourceName: "团友网",
    sourceUrl: articleBase + link[1],
    updatedAt,
    windowDate: expectedWindow,
    workday
  };
}

function normalizedText(value) {
  return value.replace(/&#(x[\da-f]+|\d+);/gi, (entity, code) => {
    const number = code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code);
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : entity;
  }).replace(/&nbsp;|\s+/gi, "").replace(/年0(?=\d月)|月0(?=\d日)/g, match => match[0]);
}

function verifyArticle(html, forecast) {
  const descriptions = [...html.matchAll(/<meta\b[^>]*>/gi)].flatMap(([tag]) => {
    const attributes = Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/g)]
      .map(([, name, , value]) => [name.toLowerCase(), value]));
    return attributes.name?.toLowerCase() === "description" ? [normalizedText(attributes.content || "")] : [];
  });
  const description = descriptions.length === 1 ? descriptions[0] : "";
  const title = normalizedText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  const chineseDate = value => value.replace(/-(\d+)-(\d+)$/, (_, month, day) => `年${Number(month)}月${Number(day)}日`);
  const date = chineseDate(forecast.updatedAt);
  const shortDate = date.slice(5);
  const window = chineseDate(forecast.windowDate);
  // The source uses both 上涨/上调 and the legacy unit 元升. Compare their
  // meaning and numeric value while keeping tonne prices out of this check.
  const amounts = [...description.matchAll(/(上调|上涨|下调|下跌|下降)(\d+(?:\.\d{1,2})?)元\/?升/g)];
  const mismatch = [];
  if (!title.includes(date) || !description.startsWith(shortDate + "，")) mismatch.push("计算日期");
  if (!description.includes(window + "24时")) mismatch.push("调价窗口");
  if (Number(description.match(/第(\d{1,2})个工作日/)?.[1]) !== forecast.workday) mismatch.push("工作日");
  if (amounts.length !== 1) mismatch.push("唯一的每升调幅");
  else {
    if ((amounts[0][1].startsWith("上") ? "up" : "down") !== forecast.direction) mismatch.push("涨跌方向");
    if (Number(amounts[0][2]) !== forecast.amountPerLiter) mismatch.push("每升调幅");
  }
  if (mismatch.length) throw new Error(`forecast article disagrees with summary: ${mismatch.join("、")}`);
  return forecast;
}

async function fetchText(url) {
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: "error" });
    if (!response.ok) throw Object.assign(new Error("forecast source unavailable"), { status: response.status });
    return await response.text();
  } catch (error) { throw requestError(error, url, Date.now() - started); }
}

async function readForecast(expectedWindow, today = chinaToday(), { readText = fetchText } = {}) {
  let url = homeUrl;
  try {
    const forecast = parseHome(await readText(url), expectedWindow, today);
    url = forecast.sourceUrl;
    return verifyArticle(await readText(url), forecast);
  } catch (error) {
    error.details ||= { category: "validation", url };
    throw error;
  }
}

async function checkForecast(expectedWindow, today = chinaToday(), options) {
  try {
    const forecast = await readForecast(expectedWindow, today, options);
    const stale = Date.parse(today) - Date.parse(forecast.updatedAt) > 2 * 86400000;
    const result = stale ? failureResult("market-forecast", Object.assign(
      new Error(`本轮市场估算超过两天未更新，最近计算日期：${forecast.updatedAt}`),
      { details: { category: "validation", url: forecast.sourceUrl } })) : { id: "market-forecast", ok: true,
      latest: { url: forecast.sourceUrl, calculatedAt: forecast.updatedAt, windowDate: forecast.windowDate } };
    return { forecast, result };
  } catch (error) { return { error: error.message, result: failureResult("market-forecast", error) }; }
}

function readCheckReport(file, today) {
  try {
    const report = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(report.version === 1 && report.checkedAt === today && report.results?.length === 1,
      "本轮市场估算检查报告缺失或日期不符");
    const result = report.results[0];
    assert.ok(result.id === "market-forecast" && typeof result.ok === "boolean" &&
      (result.ok || (typeof result.error === "string" && result.error && result.failure?.category)),
    "市场估算检查结果格式异常");
    return [result];
  } catch (error) {
    return [failureResult("market-forecast", Object.assign(new Error("未取得本轮有效的市场估算检查报告"),
      { details: { category: "validation", url: homeUrl } }))];
  }
}

if (require.main === module) {
  (async () => {
    const today = process.argv[3] || chinaToday();
    const { result, ...outcome } = await checkForecast(process.argv[2], today);
    if (process.env.BESFUEL_FORECAST_REPORT) {
      fs.writeFileSync(process.env.BESFUEL_FORECAST_REPORT,
        (JSON.stringify({ version: 1, checkedAt: today, results: [result] }, null, 2) + "\n").replace(/\r?\n/g, "\r\n"));
    }
    process.stdout.write(JSON.stringify(outcome));
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { parseHome, verifyArticle, readForecast, checkForecast, readCheckReport };
