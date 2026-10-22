"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createStore } = require("./cloud-storage.cjs");
const { validateBundle } = require("./cloud-bundle.cjs");
async function download(output, { store = createStore() } = {}) {
  const result = await store.read();
  if (!result) throw new Error("OSS 尚未生成地区快照，请先执行 FC 采集");
  const bundle = validateBundle(JSON.parse(result.body.toString("utf8")));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, result.body);
  console.log(JSON.stringify({ generatedAt: bundle.generatedAt, counts: bundle.counts, output }));
  return bundle;
}
if (require.main === module) {
  if (!process.argv[2]) throw new Error("需要指定 FC 快照输出文件");
  download(path.resolve(process.argv[2])).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { download };
