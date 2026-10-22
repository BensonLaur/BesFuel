"use strict";

const fs = require("node:fs");
const path = require("node:path");
const model = require("../lib/crude.js");
const { collectSnapshot, validateFiles, writeSnapshot } = require("./update-crude.cjs");

async function updateForCI({ directory = path.resolve(__dirname, "../data"), now = new Date(), reader,
  summaryFile = process.env.GITHUB_STEP_SUMMARY, log = console.log, warn = console.warn } = {}) {
  const json = path.join(directory, "crude-prices.json"), script = path.join(directory, "crude-prices.js");
  // An upstream outage may retain a verified pair; corrupt or mismatched local
  // files are deployment errors and must not be hidden as a network failure.
  const previous = validateFiles(json, script);
  const result = await collectSnapshot(previous, { now, reader });
  writeSnapshot(result.snapshot, json, script);
  validateFiles(json, script);
  const snapshot = result.snapshot;
  const summary = [
    "### 原油趋势采集",
    `- 结果：${result.updated ? "已更新" : "全部来源失败，保留此前快照"}`,
    `- 检查时间：${snapshot.collection.checkedAt}`,
    `- 数据采集时间：${snapshot.updatedAt}`,
    `- 当前来源：${model.providers[snapshot.collection.activeProvider].displayName}`,
    ...result.attempts.map(attempt => `- ${model.providers[attempt.provider].displayName}：${attempt.ok ? "通过" : attempt.reason.replace(/[\r\n]/g, " ")}`)
  ].join("\r\n") + "\r\n";
  log(summary);
  if (summaryFile) fs.appendFileSync(summaryFile, summary + "\r\n");
  // A validated retained snapshot must reach Pages so visitors see the outage
  // status. The ordinary CLI still exits nonzero when every provider fails.
  if (!result.updated) warn("::warning::原油来源全部失败；已保留价格和采集时间，将发布本次检查失败提示。");
  return result;
}

if (require.main === module) {
  updateForCI().catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { updateForCI };
