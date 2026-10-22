"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const marker = id => `<!-- besfuel-data-alert:${id} -->`;
function problem(result) {
  if (result.ok && !result.needsReview) return null;
  if (result.ok) return { type: "review", detail: result.latest?.requiresManualCoefficientReview ?
    "季节折算系数已到期，需新的官方系数" : "发现新的官方公告，现有解析规则尚不能确认完整价格",
  url: result.latest?.url || "", immediate: true };
  const category = result.failure?.category || "validation";
  return { type: category, detail: category === "validation" ? result.error.slice(0, 500) :
    `官方来源持续访问失败（${category}${result.failure?.status ? ` ${result.failure.status}` : ""}）`,
  url: result.failure?.url || "", immediate: category === "validation" };
}
function planAlerts(report, previous, runKey) {
  assert.equal(report.version, 1, "核价报告格式异常");
  assert.ok(Array.isArray(report.results), "核价报告结果缺失");
  const state = structuredClone(previous || { version: 1, entries: {} }), actions = [];
  assert.equal(state.version, 1, "提醒状态格式异常");
  for (const result of report.results) {
    assert.match(result.id, /^[a-z][a-z0-9-]*$/);
    const current = problem(result), prior = state.entries[result.id];
    if (!current) {
      if (prior?.alerted) actions.push({ id: result.id, kind: "resolve" });
      state.entries[result.id] = { signature: null, consecutive: 0, alerted: false, lastRun: runKey };
      continue;
    }
    const signature = crypto.createHash("sha256").update(JSON.stringify(current)).digest("hex");
    const same = prior?.signature === signature;
    const consecutive = same ? prior.consecutive + (prior.lastRun === runKey ? 0 : 1) : 1;
    const entry = { signature, consecutive, alerted: same ? prior.alerted : false, lastRun: runKey };
    if (!entry.alerted && (current.immediate || consecutive >= 3)) {
      actions.push({ id: result.id, kind: "alert", ...current, signature });
      entry.alerted = true;
    }
    state.entries[result.id] = entry;
  }
  return { state, actions };
}
async function deliver(actions, { token, repository, runUrl, fetcher = fetch } = {}) {
  if (!actions.length) return;
  assert.ok(token && /^[\w.-]+\/[\w.-]+$/.test(repository), "缺少 GitHub 提醒配置");
  async function api(endpoint, method = "GET", value) {
    const response = await fetcher(`https://api.github.com/repos/${repository}${endpoint}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
        "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" },
      ...(value ? { body: JSON.stringify(value) } : {}), signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) throw new Error(`GitHub 异常提醒失败：HTTP ${response.status}`);
    return response.json();
  }
  const issues = [];
  for (let page = 1; ; page++) {
    const batch = await api(`/issues?state=open&per_page=100&page=${page}`);
    issues.push(...batch.filter(issue => !issue.pull_request && issue.user?.login === "github-actions[bot]"));
    if (batch.length < 100) break;
    assert.ok(page < 10, "未能完整读取异常记录列表");
  }
  for (const action of actions) {
    const existing = issues.filter(issue => issue.body?.includes(marker(action.id)));
    if (action.kind === "resolve") {
      for (const issue of existing) await api(`/issues/${issue.number}`, "PATCH", { state: "closed", state_reason: "completed" });
      continue;
    }
    const fingerprint = `<!-- evidence:${action.signature} -->`;
    // A retry after a successful API write must not create another notification.
    if (existing.some(issue => issue.body?.includes(fingerprint))) continue;
    const safeDetail = action.detail.replace(/@/g, "＠").replace(/[<>]/g, "");
    const body = `${marker(action.id)}\n${fingerprint}\n\n@${repository.split("/")[0]}，该地区出现需要处理的新异常。\n\n` +
      `${safeDetail}\n\n已保留此前可信价格和核对日期；如适用系数到期，页面继续隐藏失效升价。\n\n` +
      `${action.url ? `官方依据：${action.url}\n\n` : ""}[核价运行](${runUrl})\n\n同一异常不会重复提醒，核对恢复后自动关闭本记录。`;
    for (const issue of existing) await api(`/issues/${issue.number}`, "PATCH", { state: "closed", state_reason: "not_planned" });
    issues.push(await api("/issues", "POST", { title: `[油价核验] ${action.id} 需要处理`, body }));
  }
}
async function main() {
  const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const file = path.join(root, "data/review-alert-state.json");
  const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
  const plan = planAlerts(report, previous, process.env.GITHUB_RUN_ID || `local-${report.checkedAt}`);
  if (process.env.GITHUB_ACTIONS === "true") {
    await deliver(plan.actions, { token: process.env.GITHUB_TOKEN, repository: process.env.GITHUB_REPOSITORY,
      runUrl: `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` });
    // Persist only after delivery succeeds, so a failed notification is retried.
    fs.writeFileSync(file, (JSON.stringify(plan.state, null, 2) + "\n").replace(/\r?\n/g, "\r\n"));
  }
  console.log(`异常提醒：${plan.actions.filter(a => a.kind === "alert").length} 项新异常，${plan.actions.filter(a => a.kind === "resolve").length} 项恢复；相同异常不重复通知。`);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { problem, planAlerts, deliver };
