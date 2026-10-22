"use strict";
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { collectBundle } = require("../../scripts/cloud-bundle.cjs");
const { createStore } = require("../../scripts/cloud-storage.cjs");
const { collectExtras } = require("../../scripts/cloud-extra.cjs");
const { collectEvidence } = require("../../scripts/cloud-evidence.cjs");
const { counts } = require("../../scripts/source-health.cjs");

async function execute(event, context, { store, collect = collectBundle,
  collectExtra = collect === collectBundle ? collectExtras : null,
  collectDocuments = collect === collectBundle ? collectEvidence : null, revision } = {}) {
  if (Buffer.isBuffer(event) || typeof event === "string") event = JSON.parse(String(event));
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("无效的 FC 事件");
  // Only console/API and timer events are accepted. No public HTTP collection endpoint.
  if (event.requestContext || event.httpMethod) throw new Error("采集函数不接受 HTTP 触发器请求");
  const mode = event.mode || "collect";
  if (mode !== "collect") throw new Error("不支持的采集模式");
  const destination = store || createStore({ credentials: context?.credentials, internal: true });
  net.setDefaultAutoSelectFamilyAttemptTimeout(2000);
  const buildRevision = revision || fs.readFileSync(path.join(__dirname, "REVISION"), "utf8").trim();
  const bundle = await collect({ revision: buildRevision });
  if (collectExtra) {
    bundle.extra = await collectExtra(bundle);
  }
  if (collectDocuments) bundle.evidence = await collectDocuments(bundle);
  if (collectExtra || collectDocuments) bundle.generatedAt = new Date().toISOString();
  const stored = await destination.publish(bundle);
  const extraCounts = bundle.extra ? counts(bundle.extra.results) : null;
  const evidenceCounts = bundle.evidence ? counts(bundle.evidence.results) : null;
  const result = { generatedAt: bundle.generatedAt,
    counts: { ...bundle.counts, ...(extraCounts ? { extra: extraCounts } : {}), ...(evidenceCounts ? { evidence: evidenceCounts } : {}) },
    healthy: !bundle.counts.sources.failed && !bundle.counts.monitors.failed && !extraCounts?.failed && !evidenceCounts?.failed, storage: stored };
  // A partial collection is still a useful complete report. The consumer keeps
  // failed regions unchanged and emits their errors, without rerunning every site.
  console.log(JSON.stringify(result));
  return result;
}
exports.handler = execute;
exports.execute = execute;
