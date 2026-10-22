"use strict";
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const root = path.resolve(__dirname, "..");
const port = Number(process.env.BESFUEL_PREVIEW_PORT || 4173);
const files = new Set([
  "index.html", "styles.css", "app.js", "crude-ui.js", "lib/calc.js", "lib/history.js", "lib/crude.js",
  "data/prices.json", "data/prices.js", "data/crude-prices.json", "data/crude-prices.js",
  "resources/support/wechat.png", "resources/support/alipay.png"
]);
const types = { ".html": "text/html", ".js": "application/javascript", ".json": "application/json", ".css": "text/css", ".png": "image/png" };
const server = http.createServer((request, response) => {
  if (!["GET", "HEAD"].includes(request.method)) { response.writeHead(405).end(); return; }
  let file;
  try { file = decodeURIComponent(new URL(request.url, "http://localhost").pathname).slice(1) || "index.html"; }
  catch (_) { response.writeHead(400).end(); return; }
  if (!files.has(file)) { response.writeHead(404).end(); return; }
  fs.readFile(path.join(root, file), (error, content) => {
    if (error) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Type": `${types[path.extname(file)]}${file.endsWith(".png") ? "" : "; charset=utf-8"}`, "Cache-Control": "no-store" });
    response.end(request.method === "HEAD" ? undefined : content);
  });
});
server.on("error", error => { console.error(`本地预览启动失败：${error.message}`); process.exitCode = 1; });
server.listen(port, "127.0.0.1", () => console.log(`BesFuel 本地预览：http://127.0.0.1:${server.address().port}/`));
