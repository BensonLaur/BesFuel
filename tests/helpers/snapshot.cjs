"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const grades = ["92", "95", "diesel"];

function regionFromRecord(record) {
  const latest = record.notices.at(-1);
  const region = {
    name: record.name, priceScope: record.priceScope, checkedAt: record.checkedAt,
    source: { name: record.sourceName, url: record.latestNotice?.sourceUrl || latest.url },
    effectiveLabel: `${latest.publishedDate} 24:00 起`,
    grades: Object.fromEntries(grades.map(grade => [grade, {
      price: latest.prices[grade],
      history: record.notices.map(notice => ({ date: notice.effectiveDate,
        price: notice.prices[grade], sourceUrl: notice.url }))
    }]).concat([["98", { price: null, history: [] }]]))
  };
  if (record.latestNotice) region.latestNotice = structuredClone(record.latestNotice);
  if (record.historyGaps) region.historyGaps = record.historyGaps.map(gap => ({
    date: new Date(Date.parse(gap.publishedDate) + 86400000).toISOString().slice(0, 10),
    sourceUrl: gap.url, reason: gap.reason
  }));
  if (record.conversion) {
    region.priceValidThrough = record.conversion.validThrough;
    region.conversionSource = { url: record.conversion.url, ruleUrl: record.conversion.ruleUrl,
      validThrough: record.conversion.validThrough };
  }
  return region;
}

function createSnapshot(...ids) {
  const data = {
    version: 2, checkedAt: "2026-10-29",
    nationalAdjustment: {
      nextAdjustment: { date: "2026-10-29", dateLabel: "预计 2026-10-29 24:00",
        sourceName: "国家发展改革委调价规则与国务院放假安排",
        sourceUrl: "https://www.ndrc.gov.cn/xxgk/zcfb/tz/201601/W020190905506573420251.pdf",
        holidaySourceUrl: "https://www.beijing.gov.cn/cs/gncs/zcwj/202603/t20260327_4568275.html" },
      forecast: {}
    },
    regions: { guangdong: regionFromRecord({
      name: "广东", priceScope: "广东省官方最高零售价测试样本。", checkedAt: "2026-10-22",
      sourceName: "广东省发展和改革委员会", notices: [
        { publishedDate: "2026-09-10", effectiveDate: "2026-09-11",
          url: "https://drc.gd.gov.cn/ywgg/content/post_9000001.html", prices: { "92": 8.31, "95": 9.01, diesel: 8.03 } },
        { publishedDate: "2026-09-24", effectiveDate: "2026-09-25",
          url: "https://drc.gd.gov.cn/ywgg/content/post_9000002.html", prices: { "92": 8.63, "95": 9.35, diesel: 8.31 } }
      ]
    }) }
  };
  // Audited records are test inputs; never seed behavior tests from the mutable
  // published snapshot or call the importer being tested to construct its input.
  for (const id of ids) {
    const file = path.join(root, "data/verified", `${id}.json`);
    let record;
    if (fs.existsSync(file)) record = JSON.parse(fs.readFileSync(file, "utf8"));
    else {
      const source = require(path.join(root, "scripts/sources", `${id}.cjs`));
      record = { ...source, checkedAt: "2026-10-22", notices: [{
        publishedDate: "2026-09-24", effectiveDate: "2026-09-25",
        url: `https://${source.allowedHostnames[0]}/test-price-20260924.html`,
        prices: { "92": 8.5, "95": 9, diesel: 8 }
      }] };
      if (id.startsWith("inner-mongolia-")) record.latestNotice = {
        kind: "unchanged", date: "2026-10-15", title: "成品油价格不作调整",
        sourceUrl: `https://${source.allowedHostnames[0]}/test-unchanged-20261015.html`
      };
    }
    data.regions[id] = regionFromRecord(record);
    if (record.checkedAt > data.checkedAt) data.checkedAt = record.checkedAt;
  }
  return data;
}

if (require.main === module) {
  const { writeSnapshot } = require("../../scripts/update-regions.cjs");
  writeSnapshot(createSnapshot(), process.argv[2], process.argv[3]);
}

module.exports = { createSnapshot };
