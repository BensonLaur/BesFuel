"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { makeReader, updateAll } = require("./update-regions.cjs");
const { checkMonitors } = require("./check-monitors.cjs");
const { counts, reportHealth } = require("./source-health.cjs");
const runFile = promisify(execFile);

async function auditSources({ sources, monitors, initial, readerOptions = {}, summaryFile = process.env.GITHUB_STEP_SUMMARY } = {}) {
  const requests = [], cache = new Map();
  const reader = hosts => makeReader(hosts, { ...readerOptions, cache,
    onRequest: item => { requests.push(item); if (!item.ok) console.warn(JSON.stringify(item)); } });
  const sourceResults = (await updateAll({ sources, initial, reader })).results;
  const monitorResults = await checkMonitors({ modules: monitors, data: initial, reader });
  // Both collectors work on in-memory snapshots. Auditing must not call either
  // CLI's writer or refresh dates merely because a connectivity probe passed.
  reportHealth("地区自动采集", sourceResults, summaryFile);
  reportHealth("人工核价地区公告监测", monitorResults, summaryFile);
  return { checkedAt: new Date().toISOString(), runtime: { node: process.version, platform: process.platform },
    counts: { sources: counts(sourceResults), monitors: counts(monitorResults) }, sources: sourceResults, monitors: monitorResults, requests };
}

async function probeCurl(requests) {
  const urls = [...new Map(requests.filter(item => !item.ok).map(item => [new URL(item.url).hostname, item.url])).values()];
  const results = [];
  // Comparison only: retain certificate verification, use no proxy and never
  // follow redirects outside the collector's allowlist implicitly.
  for (const url of urls) {
    try {
      const result = await runFile(process.platform === "win32" ? "curl.exe" : "curl", [
        "--silent", "--show-error", "--ipv4", "--noproxy", "*", "--connect-timeout", "8", "--max-time", "20",
        "--output", process.platform === "win32" ? "NUL" : "/dev/null", "--write-out", "%{http_code} %{remote_ip} %{ssl_verify_result}", url
      ], { windowsHide: true, timeout: 25000, maxBuffer: 100000 });
      const status = Number(result.stdout.trim().split(/\s+/)[0]);
      results.push({ url, ok: status >= 200 && status < 300, transportOk: true, status,
        response: result.stdout.trim(), stderr: result.stderr.trim() });
    } catch (error) {
      results.push({ url, ok: false, transportOk: false, code: error.code,
        response: String(error.stdout || "").trim(), error: String(error.stderr || error.message).trim() });
    }
    console.log("curl comparison", JSON.stringify(results.at(-1)));
  }
  return results;
}

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== "--probe-curl" && !arg.startsWith("--output="))) throw new Error("支持 --output=路径 和 --probe-curl");
    const output = args.find(arg => arg.startsWith("--output="))?.slice(9) || path.join(os.tmpdir(), "besfuel-source-health.json");
    const report = await auditSources();
    if (args.includes("--probe-curl")) report.curl = await probeCurl(report.requests);
    fs.writeFileSync(output, JSON.stringify(report, null, 2).replace(/\n/g, "\r\n") + "\r\n");
    console.log(`只读来源报告：${output}`);
    if (report.counts.sources.failed || report.counts.monitors.failed) process.exitCode = 1;
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { auditSources };
