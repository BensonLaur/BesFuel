"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { makeReader } = require("./update-regions.cjs");
const { fetchOfficial } = require("./source-transport.cjs");
const execute = promisify(execFile);

async function windowsCurl(url, options = {}) {
  if (process.platform !== "win32" || new URL(url).hostname !== "drc.jiangxi.gov.cn") {
    throw new Error("仅江西官网使用 Windows 系统 TLS 兼容读取器");
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "besfuel-official-"));
  const body = path.join(directory, "body"), headers = path.join(directory, "headers");
  try {
    // Curl does not follow redirects here: makeReader checks every destination.
    // Schannel retains certificate verification; no insecure legacy TLS flags.
    const result = await execute("curl.exe", ["--silent", "--show-error", "--proto", "=https",
      "--connect-timeout", "8", "--max-time", "20", "--max-filesize", "5000000",
      "--dump-header", headers, "--output", body, "--write-out", "%{http_code}", url],
    { windowsHide: true, timeout: 22000, maxBuffer: 10000, signal: options.signal });
    const status = Number(result.stdout.trim());
    const blocks = fs.readFileSync(headers, "latin1").trim().split(/\r?\n\r?\n/);
    const last = blocks.at(-1).split(/\r?\n/).slice(1);
    const parsed = new Headers();
    for (const line of last) {
      const colon = line.indexOf(":");
      if (colon > 0) parsed.append(line.slice(0, colon), line.slice(colon + 1).trim());
    }
    const bytes = fs.readFileSync(body);
    if (bytes.length > 5_000_000) throw new Error("官方文件过大");
    return new Response([204, 205, 304].includes(status) ? null : bytes, { status, headers: parsed });
  } finally {
    for (const file of [body, headers]) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(directory);
  }
}
function publishingReader(hosts) {
  return makeReader(hosts, { timeoutMs: 23000, fetcher: (url, options) =>
    new URL(url).hostname === "drc.jiangxi.gov.cn" ? windowsCurl(url, options) : fetchOfficial(url, options) });
}
module.exports = { publishingReader, windowsCurl };
