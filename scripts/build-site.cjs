"use strict";

const fs = require("node:fs");
const path = require("node:path");
const prices = require("./validate-data.cjs");
const crude = require("./update-crude.cjs");
const root = path.resolve(__dirname, "..");
const siteFiles = [
  "index.html", "styles.css", "app.js", "crude-ui.js", "lib/calc.js", "lib/history.js", "lib/crude.js",
  "data/prices.json", "data/prices.js", "data/crude-prices.json", "data/crude-prices.js",
  "resources/support/wechat.png", "resources/support/alipay.png"
];

function validateSiteData(directory) {
  prices.validateFiles(path.join(directory, "data/prices.json"), path.join(directory, "data/prices.js"));
  crude.validateFiles(path.join(directory, "data/crude-prices.json"), path.join(directory, "data/crude-prices.js"));
}
function buildSite(destination = path.join(root, "public")) {
  validateSiteData(root);
  for (const file of siteFiles) {
    const target = path.join(destination, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, file), target);
  }
  fs.writeFileSync(path.join(destination, ".nojekyll"), "");
  validateSiteData(destination);
  return destination;
}

if (require.main === module) {
  try { console.log(`静态站点已生成并校验：${buildSite()}`); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
module.exports = { siteFiles, buildSite, validateSiteData };
