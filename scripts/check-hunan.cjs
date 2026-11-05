"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { publishingReader } = require("./publish-reader.cjs");
const { chinaDate } = require("./update-regions.cjs");
const { readHunan } = require("./automatic-hunan.cjs");
const monitor = require("./monitors/hunan.cjs");

async function main() {
  const directory = path.resolve(process.argv[2]);
  fs.mkdirSync(directory, { recursive: true });
  const source = publishingReader(monitor.allowedHostnames);
  const reader = { ...source, getBuffer: async url => {
    const result = await source.getBuffer(url);
    fs.writeFileSync(path.join(directory, "hunan.xls"), result.buffer);
    return result;
  } };
  const latest = await monitor.collect({ ...reader, today: chinaDate() });
  const verified = await readHunan(latest, reader);
  fs.writeFileSync(path.join(directory, "hunan.json"), JSON.stringify(verified, null, 2));
  console.log(JSON.stringify(verified));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
