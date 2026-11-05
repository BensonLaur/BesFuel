"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { makeReader } = require("./update-regions.cjs");
const { fetchOfficial } = require("./source-transport.cjs");
const execute = promisify(execFile);

async function windowsCurl(url, options = {}, run = execute) {
  const target = new URL(url);
  if (process.platform !== "win32" || target.protocol !== "https:" || target.username || target.password ||
      !["drc.jiangxi.gov.cn", "fgw.hunan.gov.cn"].includes(target.hostname)) {
    throw new Error("仅江西、湖南官网使用 Windows HTTPS 兼容读取器");
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "besfuel-official-"));
  const body = path.join(directory, "body"), headers = path.join(directory, "headers");
  try {
    // Curl does not follow redirects here: makeReader checks every destination.
    // Schannel retains certificate verification; no insecure legacy TLS flags.
    let result;
    try { result = await run("curl.exe", ["--silent", "--show-error", "--proto", "=https",
      "--connect-timeout", "8", "--max-time", "20", "--max-filesize", "5000000",
      "--dump-header", headers, "--output", body, "--write-out", "%{http_code}", url],
    { windowsHide: true, timeout: 22000, maxBuffer: 10000, signal: options.signal }); }
    catch (error) {
      // Use one alternate client for malformed metadata or transient network
      // failures. The caller's original deadline also bounds this second request;
      // certificate/TLS failures and HTTP refusals never enter this recovery.
      const malformedHeader = error.code === 8 && /Header without colon/i.test(error.stderr || "");
      const transientNetwork = [6, 7, 28, 52, 55, 56].includes(error.code);
      if (target.hostname !== "fgw.hunan.gov.cn" || (!malformedHeader && !transientNetwork)) throw error;
      console.log(`湖南官网${malformedHeader ? "响应头缺少冒号" : "临时网络故障"}，使用标准库 HTTPS 重新读取：${url}`);
      const recovered = await run(process.env.BESFUEL_PYTHON || "python", [path.join(__dirname, "read-hunan-http.py"), url],
        { windowsHide: true, timeout: 22000, maxBuffer: 7_000_000, signal: options.signal });
      const value = JSON.parse(recovered.stdout);
      const bytes = Buffer.from(value.base64, "base64");
      if (bytes.length > 5_000_000) throw new Error("官方文件过大");
      return new Response([204, 205, 304].includes(value.status) ? null : bytes, { status: value.status, headers: value.headers });
    }
    const status = Number(result.stdout.trim());
    const blocks = fs.readFileSync(headers, "latin1").trim().split(/\r?\n\r?\n/);
    const last = blocks.at(-1).split(/\r?\n/).slice(1);
    const parsed = new Headers();
    for (const line of last) {
      const colon = line.indexOf(":");
      // Attachment filenames can contain invalid header bytes. Only these two
      // headers affect our reader; redirect destinations are still validated.
      const name = line.slice(0, colon).toLowerCase();
      if (colon > 0 && ["content-type", "location"].includes(name)) parsed.append(name, line.slice(colon + 1).trim());
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
  const primary = makeReader(hosts, { timeoutMs: 23000, fetcher: (url, options) =>
    ["drc.jiangxi.gov.cn", "fgw.hunan.gov.cn"].includes(new URL(url).hostname) && process.platform === "win32" ?
      windowsCurl(url, options) : fetchOfficial(url, options) });
  return publicHttpFallback(primary, makeReader(hosts));
}
function publicHttpFallback(primary, fallback) {
  return Object.fromEntries(["getText", "getBuffer"].map(method => [method, async url => {
    try { return await primary[method](url); }
    catch (error) {
      const parsed = new URL(url);
      // Both portals also publish the same public notices on HTTP. Only a
      // connection failure can use it; certificate failures are never bypassed.
      if (parsed.protocol !== "https:" || !["plan.hainan.gov.cn", "drc.jiangxi.gov.cn"].includes(parsed.hostname) ||
        !["timeout", "network"].includes(error.details?.category) ||
        error.details?.causes?.some(cause => /cert|ssl|tls|schannel/i.test(`${cause.code} ${cause.message}`))) throw error;
      parsed.protocol = "http:";
      console.log(`尝试官网同时提供的 HTTP 公告入口：${parsed.href}`);
      return fallback[method](parsed.href);
    }
  }]));
}
module.exports = { publishingReader, windowsCurl, publicHttpFallback };
