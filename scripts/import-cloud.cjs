"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { MAX_BYTES, applyBundle } = require("./cloud-bundle.cjs");
const { writeSnapshot } = require("./update-regions.cjs");
const { validateFiles } = require("./validate-data.cjs");
const { reportHealth } = require("./source-health.cjs");
function importFile(file, { root = path.resolve(__dirname, ".."), summaryFile = process.env.GITHUB_STEP_SUMMARY } = {}) {
  const jsonPath = path.join(root, "data/prices.json"), scriptPath = path.join(root, "data/prices.js");
  const initial = validateFiles(jsonPath, scriptPath);
  if (fs.statSync(file).size > MAX_BYTES) throw new Error("FC 快照超出大小上限");
  const bundle = JSON.parse(fs.readFileSync(file, "utf8"));
  const result = applyBundle(bundle, initial);
  writeSnapshot(result.data, jsonPath, scriptPath);
  console.log(`采用 FC 地区快照：${bundle.generatedAt}；采集代码：${bundle.revision}`);
  reportHealth("FC 地区自动采集", result.sources, summaryFile);
  reportHealth("FC 人工核价地区公告监测", result.monitors, summaryFile);
  return result;
}
if (require.main === module) {
  try {
    if (!process.argv[2]) throw new Error("需要指定 FC 快照输入文件");
    importFile(path.resolve(process.argv[2]));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { importFile };
