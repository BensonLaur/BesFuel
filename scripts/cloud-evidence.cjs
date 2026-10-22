"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { makeReaderFactory, officialUrl } = require("./update-regions.cjs");
const { failureResult } = require("./source-errors.cjs");

// Transport original official documents. Parsers run on the publishing side,
// so fixing a PDF/Word parser does not require another FC runtime deployment.
const GROUPS = Object.freeze({
  xizang: ["xizang-lhasa", "xizang-changdu", "xizang-ngari"],
  zhejiang: ["zhejiang"],
  sichuan: ["sichuan-zone2"],
  jilin: ["jilin"],
  yunnan: ["yunnan-kunming", "yunnan-zone2", "yunnan-zone3", "yunnan-zone4", "yunnan-zone5"]
});
const MAX_DOCUMENT_BYTES = 1_000_000;
function plan(bundle, group) {
  const ids = GROUPS[group];
  assert.ok(ids, "未知的附件采集组");
  const results = ids.map(id => bundle.monitors.find(item => item.id === id));
  assert.ok(results.every(item => item?.ok), `${group}: 对应的官方公告尚未通过检查`);
  const latest = results[0].latest;
  assert.ok(results.every(item => item.latest.url === latest.url && item.latest.publishedDate === latest.publishedDate),
    `${group}: 分价区公告不一致`);
  const urls = [latest.url];
  if (["jilin", "yunnan"].includes(group)) urls.push(latest.pdfUrl);
  if (group === "sichuan") urls.push(latest.attachmentUrl);
  const hosts = require(`../data/verified/${ids[0]}.json`).allowedHostnames;
  assert.ok(urls.every(url => officialUrl(url, hosts)), `${group}: 附件不是已核对的官方网站地址`);
  return { urls, hosts, latest };
}
function decodeDocument(document) {
  assert.ok(typeof document?.base64 === "string" && document.base64.length <= Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4,
    "官方附件缺失或超过大小限制");
  const buffer = Buffer.from(document.base64, "base64");
  assert.ok(buffer.length > 0 && buffer.length <= MAX_DOCUMENT_BYTES && buffer.toString("base64") === document.base64,
    "官方附件编码无效");
  assert.equal(crypto.createHash("sha256").update(buffer).digest("hex"), document.sha256, "官方附件哈希不符");
  return buffer;
}
async function collectEvidence(bundle, readerFactory = makeReaderFactory()) {
  const results = [];
  for (const id of Object.keys(GROUPS)) {
    try {
      const { urls, hosts } = plan(bundle, id), reader = readerFactory(hosts), documents = [];
      for (const url of urls) {
        const { buffer } = await reader.getBuffer(url);
        assert.ok(buffer.length > 0 && buffer.length <= MAX_DOCUMENT_BYTES, `${id}: 官方附件大小异常`);
        documents.push({ url, sha256: crypto.createHash("sha256").update(buffer).digest("hex"), base64: buffer.toString("base64") });
      }
      results.push({ id, ok: true, documents });
    } catch (error) { results.push(failureResult(id, error)); }
  }
  return { version: 1, results };
}
function validateEvidence(bundle) {
  if (!bundle.evidence) return null;
  assert.equal(bundle.evidence.version, 1, "不支持的官方附件格式");
  assert.ok(Array.isArray(bundle.evidence.results), "缺少官方附件结果");
  assert.deepEqual(bundle.evidence.results.map(item => item.id).sort(), Object.keys(GROUPS).sort(), "官方附件采集组缺失或重复");
  const results = new Map();
  for (const result of bundle.evidence.results) {
    assert.equal(typeof result.ok, "boolean", "官方附件状态异常");
    if (result.ok) {
      const { urls } = plan(bundle, result.id);
      assert.deepEqual(result.documents?.map(document => document.url), urls, `${result.id}: 附件与当轮公告不匹配`);
      result.documents.forEach(decodeDocument);
    } else {
      assert.ok(typeof result.error === "string" && result.error.length > 0 && result.error.length <= 10000, "缺少附件失败原因");
    }
    results.set(result.id, result);
  }
  return results;
}
module.exports = { GROUPS, MAX_DOCUMENT_BYTES, plan, decodeDocument, collectEvidence, validateEvidence };
