"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { officialUrl, validateNotices } = require("./update-regions.cjs");

const configurations = {
  hainan: { host: "plan.hainan.gov.cn", title: "海南省成品油价格按机制调整", source: "价格处",
    article: /^\/sfgw\/gzdt\/(\d{6})\/[a-f0-9]{32}\.shtml$/ },
  jiangxi: { host: "drc.jiangxi.gov.cn", title: "江西省发展改革委关于成品油价格调整的通告",
    source: "江西省发展和改革委员会", article: /^\/jxsfzhggwyh\/col\/col14590\/content\/content_\d+\.html$/ }
};
function compact(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<[^>]*>/g, "")
    .replace(/&(?:nbsp|ensp|emsp|#160|#x[aA]0);/gi, "").replace(/[\s\u3000]/g, "");
}
function metadata(html, name) {
  const values = [...html.matchAll(new RegExp(`<meta\\b[^>]*name=["']${name}["'][^>]*content=["']([^"']*)["'][^>]*>`, "gi"))]
    .map(m => m[1].trim());
  assert.ok(values.length && new Set(values).size === 1, `${name} 缺失或冲突`);
  return values[0];
}
function articleUrl(id, reference) {
  const config = configurations[id], url = new URL(reference, `https://${config.host}/`);
  assert.ok(url.protocol === "https:" && officialUrl(url.href, [config.host]) &&
    !url.port && !url.search && !url.hash && config.article.test(url.pathname), `${id}: 公告地址不符`);
  return url.href;
}
function discover(id, html) {
  const config = configurations[id];
  let entries;
  if (id === "jiangxi") {
    const blocks = [...html.matchAll(/var\s+col14590\s*=\s*(\[[^\r\n]+\])/g)];
    assert.equal(blocks.length, 1, "江西公告列表缺失或重复");
    const rows = JSON.parse(blocks[0][1]);
    assert.ok(Array.isArray(rows) && rows.length <= 100, "江西公告列表格式异常");
    entries = rows.filter(row => /成品油/.test(row.title)).map(row => {
      assert.equal(row.title, config.title, "江西出现未知油价公告类型");
      return { url: articleUrl(id, JSON.parse(row.urls).pc), date: row.pubDate.slice(0, 10) };
    });
  } else {
    entries = [...html.matchAll(/<a\b([^>]*)>([\s\S]{0,2000}?)<\/a>/gi)]
      .filter(m => /成品油/.test(compact(m[2])))
      .map(m => {
        assert.equal(compact(m[2]), config.title, "海南出现未知油价公告类型");
        const href = m[1].match(/\bhref=["']([^"']+)["']/i)?.[1];
        assert.ok(href, "海南公告缺少链接");
        return { url: articleUrl(id, href) };
      });
  }
  assert.ok(entries.length && entries.length <= 12, `${id}: 官方首页没有完整油价公告列表`);
  return [...new Map(entries.map(entry => [entry.url, entry])).values()];
}
function parseArticle(id, html, entry) {
  const config = configurations[id];
  articleUrl(id, entry.url);
  assert.equal(metadata(html, "ArticleTitle"), config.title, `${id}: 标题不符`);
  assert.equal(metadata(html, "ContentSource"), config.source, `${id}: 发布来源不符`);
  const date = metadata(html, "PubDate").slice(0, 10);
  assert.ok(/^\d{4}-\d\d-\d\d$/.test(date) && new Date(date).toISOString().slice(0, 10) === date, "公告日期无效");
  if (entry.date) assert.equal(entry.date, date, "列表与公告日期不一致");
  if (id === "hainan") assert.ok(new URL(entry.url).pathname.includes(date.slice(0, 7).replace("-", "")), "海南公告月份不符");
  const [year, month, day] = date.split("-").map(Number), text = compact(html);
  const expression = id === "hainan" ? new RegExp(`自(?:${year}年)?${month}月${day}日24时起执行`) :
    new RegExp(`自${year}年${month}月${day}日24时起执行`);
  assert.ok(expression.test(text), `${id}: 生效时间与公告不一致`);
  if (id === "hainan") assert.ok(text.includes("每升汽油含1.05元车辆通行附加费，0号柴油未含车辆通行附加费"), "海南附加费口径变化");
  const tables = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)]
    .map(table => [...table[0].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map(row => [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => compact(cell[1]))))
    .filter(rows => rows[0]?.join("|") === (id === "hainan" ? "项目|最高零售价格" : "品名|最高零售价") &&
      rows[1]?.join("|") === "元/吨|元/升");
  assert.equal(tables.length, 1, `${id}: 元/升零售表缺失或重复`);
  const prices = {};
  for (const [grade, label] of [["92", id === "hainan" ? "92#汽油" : "92号车用汽油"],
    ["95", id === "hainan" ? "95#汽油" : "95号车用汽油"], ["diesel", id === "hainan" ? "0#柴油" : "0号车用柴油"]]) {
    const matches = tables[0].filter(row => row.includes(label));
    assert.equal(matches.length, 1, `${id}/${grade}: 价格行缺失或重复`);
    const row = matches[0], start = row.indexOf(label);
    assert.ok(row.length === start + 3 && /^\d{4,5}$/.test(row[start + 1]) && /^\d{1,2}\.\d{2}$/.test(row[start + 2]), `${id}/${grade}: 单位或列数变化`);
    prices[grade] = Number(row[start + 2]);
  }
  return { publishedDate: date, effectiveDate: new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10),
    url: entry.url, prices, sourceSha256: crypto.createHash("sha256").update(html).digest("hex") };
}
async function collectTable(record, reader, today) {
  const id = record.id, config = configurations[id];
  const entries = discover(id, await reader.getText(`https://${config.host}/`));
  const notices = [];
  for (const entry of entries) notices.push(parseArticle(id, await reader.getText(entry.url), entry));
  const current = notices.filter(n => n.effectiveDate <= today).sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  validateNotices(record, current, today);
  return current;
}
module.exports = { configurations, discover, parseArticle, collectTable };
