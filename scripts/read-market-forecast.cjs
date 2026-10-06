const { chinaToday, isValidDate } = require("./date-utils.cjs");

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

function verifyArticle(html, forecast) {
  const description = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i)?.[1] || "";
  const date = forecast.updatedAt.replace(/-(0?\d+)-(0?\d+)$/, (_, month, day) => `年${Number(month)}月${Number(day)}日`);
  const shortDate = date.slice(5);
  const window = forecast.windowDate.replace(/-(0?\d+)-(0?\d+)$/, (_, month, day) => `年${Number(month)}月${Number(day)}日`);
  const amountText = `${forecast.direction === "up" ? "上调" : "下调"}${forecast.amountPerLiter.toFixed(2)}元`;
  if (!html.includes(date) || !description.includes(shortDate) || !description.includes(window) ||
      !(description.includes(`${amountText}升`) || description.includes(`${amountText}/升`))) {
    throw new Error("forecast article disagrees with summary");
  }
  return forecast;
}

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok || new URL(response.url).hostname !== "www.tuanyou.net") throw new Error("forecast source unavailable");
  return response.text();
}

async function readForecast(expectedWindow, today = chinaToday()) {
  const forecast = parseHome(await fetchText(homeUrl), expectedWindow, today);
  return verifyArticle(await fetchText(forecast.sourceUrl), forecast);
}

if (require.main === module) {
  readForecast(process.argv[2], process.argv[3] || chinaToday())
    .then(forecast => process.stdout.write(JSON.stringify({ forecast })))
    .catch(error => process.stdout.write(JSON.stringify({ error: error.message })));
}

module.exports = { parseHome, verifyArticle, readForecast };
