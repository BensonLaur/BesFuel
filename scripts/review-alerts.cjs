"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { buildSummary, deliver, renderSummary, SUMMARY_MARKER } = require("./review-summary.cjs");
const root = path.resolve(__dirname, "..");
function problem(result) {
  if (result.ok && !result.needsReview) return null;
  if (result.ok) return { type: "review", detail: result.latest?.requiresManualCoefficientReview ?
    "季节折算系数已到期，需新的官方系数" : "发现新的官方公告，现有解析规则尚不能确认完整价格",
  url: result.latest?.url || "", immediate: true };
  const category = result.failure?.category || "validation";
  return { type: category, detail: category === "validation" ? result.error.slice(0, 500) :
    `官方来源持续访问失败（${category}${result.failure?.status ? ` ${result.failure.status}` : ""}）`,
  url: result.failure?.url || result.latest?.url || "", immediate: category === "validation",
  ...(category === "validation" && result.evidenceFingerprint ? { evidence: result.evidenceFingerprint } : {}) };
}
function planAlerts(report, previous, runKey) {
  assert.equal(report.version, 1, "核价报告格式异常");
  assert.ok(Array.isArray(report.results), "核价报告结果缺失");
  assert.equal(new Set(report.results.map(result => result.id)).size, report.results.length, "核价项目重复");
  const state = structuredClone(previous || { version: 1, entries: {} }), actions = [];
  assert.equal(state.version, 1, "提醒状态格式异常");
  for (const result of report.results) {
    assert.match(result.id, /^[a-z][a-z0-9-]*$/);
    const current = problem(result), prior = state.entries[result.id];
    if (!current) {
      if (prior?.alerted || prior?.openIssue) actions.push({ id: result.id, kind: "resolve" });
      state.entries[result.id] = { signature: null, consecutive: 0, alerted: false, lastRun: runKey };
      continue;
    }
    const signature = crypto.createHash("sha256").update(JSON.stringify(current)).digest("hex");
    const same = prior?.signature === signature;
    const consecutive = same ? prior.consecutive + (prior.lastRun === runKey ? 0 : 1) : 1;
    const entry = { signature, consecutive, alerted: same ? prior.alerted : false, lastRun: runKey, problem: current };
    // Keep the prior confirmed problem during a different transient error's
    // observation period, until recovery or a new problem has been confirmed.
    if (prior?.openIssue || prior?.alerted) entry.openIssue = true;
    if (!entry.alerted && (current.immediate || consecutive >= 3)) {
      actions.push({ id: result.id, kind: "alert", ...current, signature });
      entry.alerted = true;
    }
    state.entries[result.id] = entry;
  }
  const summary = buildSummary(report, previous, state, runKey);
  return { state, actions, summary };
}
async function main() {
  const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const file = path.join(root, "data/review-alert-state.json");
  const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
  const plan = planAlerts(report, previous, process.env.GITHUB_RUN_ID || `local-${report.checkedAt}`);
  if (process.env.GITHUB_ACTIONS === "true") {
    const prices = JSON.parse(fs.readFileSync(path.join(root, "data/prices.json"), "utf8"));
    const delivery = await deliver(plan, { token: process.env.GITHUB_TOKEN, repository: process.env.GITHUB_REPOSITORY,
      names: Object.fromEntries(Object.entries(prices.regions).map(([id, region]) => [id, region.name])),
      runUrl: `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` });
    if (delivery.issueNumber) plan.state.summary.issueNumber = delivery.issueNumber;
    else if (previous?.summary?.issueNumber) plan.state.summary.issueNumber = previous.summary.issueNumber;
    // Persist after complete delivery. Remote event markers also protect retries
    // if the notification succeeded but this state could not be saved afterward.
    fs.writeFileSync(file, (JSON.stringify(plan.state, null, 2) + "\n").replace(/\r?\n/g, "\r\n"));
  }
  console.log(`异常汇总：新增或变化 ${plan.summary.added.length} 项，持续 ${plan.summary.ongoing.length} 项，` +
    `已恢复 ${plan.summary.resolved.length} 项；${plan.summary.changed ? "本轮最多发送一条汇总提醒" : "事项无变化，不写入 GitHub、不提醒"}。`);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { problem, planAlerts, deliver, renderSummary, SUMMARY_MARKER };
