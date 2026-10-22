"use strict";
const fs = require("node:fs");

function counts(results) {
  return { total: results.length, passed: results.filter(item => item.ok && !item.needsReview).length,
    failed: results.filter(item => !item.ok).length, review: results.filter(item => item.ok && item.needsReview).length };
}
function reportHealth(title, results, summaryFile = process.env.GITHUB_STEP_SUMMARY) {
  const count = counts(results);
  const headline = `${title}：${count.total} 项，核对通过 ${count.passed}，采集失败 ${count.failed}，待人工复核 ${count.review}`;
  console.log(headline);
  if (process.env.GITHUB_ACTIONS && (count.failed || count.review)) {
    console.warn(`::warning::${headline}。发布成功不代表所有地区核对成功；失败地区保留旧数据和核对日期。`);
  }
  if (summaryFile) {
    const escape = text => String(text).replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|");
    const lines = [`### ${title}`, "", headline, "", "| 地区 | 结果 | 详情 |", "| --- | --- | --- |",
      ...results.map(item => `| ${item.id} | ${!item.ok ? "失败" : item.needsReview ? "待人工复核" : "通过"} | ${escape(!item.ok ? item.error :
        item.needsReview ? `公告需人工核价/确认适用期：${item.latest?.url || ""}` : item.latest?.url || `${item.count} 条官方公告`)} |`), ""];
    fs.appendFileSync(summaryFile, lines.join("\r\n") + "\r\n");
  }
  return count;
}
module.exports = { counts, reportHealth };
