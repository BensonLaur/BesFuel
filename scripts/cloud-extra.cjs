"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { makeReader, chinaDate, officialUrl, validateNotices } = require("./update-regions.cjs");
const { collectTable } = require("./automatic-tables.cjs");
const { failureResult } = require("./source-errors.cjs");
function extraDigest() {
  const hash = crypto.createHash("sha256");
  for (const file of ["cloud-extra.cjs", "automatic-tables.cjs"]) {
    hash.update(file + "\n" + fs.readFileSync(path.join(__dirname, file), "utf8").replace(/\r\n/g, "\n") + "\n");
  }
  return hash.digest("hex");
}
function record(id) { return require(`../data/verified/${id}.json`); }
async function collectExtras(bundle, readerFactory = hosts => makeReader(hosts)) {
  const results = [], today = chinaDate(new Date(bundle.startedAt));
  for (const id of ["hainan", "jiangxi"]) {
    try {
      const source = record(id), reader = readerFactory(source.allowedHostnames);
      // Jiangxi publishes the same public documents on HTTP; the Linux TLS
      // endpoint requires obsolete renegotiation, which we do not enable.
      const transport = id === "jiangxi" ? { getText: url => reader.getText(url.replace(/^https:/, "http:")) } : reader;
      results.push({ id, ok: true, notices: await collectTable(source, transport, today) });
    } catch (error) { results.push(failureResult(id, error)); }
  }
  try {
    const monitor = bundle.monitors.find(item => item.id === "hunan");
    assert.ok(monitor?.ok && officialUrl(monitor.latest.attachmentUrl, record("hunan").allowedHostnames), "湖南附件公告不可用");
    const { buffer } = await readerFactory(record("hunan").allowedHostnames).getBuffer(monitor.latest.attachmentUrl);
    assert.ok(buffer.length <= 1_000_000 && buffer.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex")), "湖南 XLS 附件格式或大小异常");
    results.push({ id: "hunan", ok: true, url: monitor.latest.attachmentUrl,
      sha256: crypto.createHash("sha256").update(buffer).digest("hex"), base64: buffer.toString("base64") });
  } catch (error) { results.push(failureResult("hunan", error)); }
  return { version: 1, digest: extraDigest(), results };
}
function validateExtras(bundle) {
  if (!bundle.extra) return null;
  const extra = bundle.extra;
  assert.ok(extra.version === 1 && extra.digest === extraDigest(), "新增采集规则不匹配，请更新 FC 包");
  assert.deepEqual(extra.results.map(item => item.id).sort(), ["hainan", "hunan", "jiangxi"]);
  for (const result of extra.results) {
    assert.equal(typeof result.ok, "boolean");
    if (!result.ok) { assert.ok(typeof result.error === "string" && result.error.length <= 10000); continue; }
    if (result.id !== "hunan") {
      validateNotices(record(result.id), result.notices, chinaDate(new Date(bundle.startedAt)));
    } else {
      const monitor = bundle.monitors.find(item => item.id === "hunan");
      assert.ok(monitor?.ok && result.url === monitor.latest.attachmentUrl &&
        officialUrl(result.url, record("hunan").allowedHostnames), "湖南附件来源与公告不匹配");
      assert.ok(typeof result.base64 === "string" && result.base64.length <= 1_333_336, "湖南附件过大");
      const bytes = Buffer.from(result.base64, "base64");
      assert.ok(bytes.toString("base64") === result.base64 &&
        crypto.createHash("sha256").update(bytes).digest("hex") === result.sha256, "湖南附件校验失败");
    }
  }
  return new Map(extra.results.map(result => [result.id, result]));
}
module.exports = { collectExtras, validateExtras, extraDigest };
