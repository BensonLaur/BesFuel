"use strict";
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const SUMMARY_MARKER = "<!-- besfuel-data-summary:v1 -->";
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ordered = items => [...items].sort((a, b) => a.id.localeCompare(b.id));

function buildSummary(report, previous, state, runKey) {
  const active = new Map((previous?.summary?.active || []).map(item => [item.id, item]));
  if (!previous?.summary) {
    // Import old per-region reminders as ongoing items. Do not re-notify each
    // region, and do not infer recovery for a missing check.
    for (const [id, entry] of Object.entries(previous?.entries || {})) {
      if (entry.signature && (entry.alerted || entry.openIssue)) active.set(id, {
        id, signature: entry.signature,
        ...(entry.problem || { type: "review", detail: "此前核验异常仍待确认", url: "" })
      });
    }
  }
  const priorActive = new Map(active);
  for (const result of report.results) {
    const entry = state.entries[result.id];
    if (!entry.signature) active.delete(result.id);
    else if (entry.alerted) active.set(result.id, { id: result.id, signature: entry.signature, ...entry.problem });
  }
  const items = ordered(active.values());
  // Run IDs, dates and consecutive counts are not material changes. A pending
  // transient failure retains the prior confirmed item until its threshold.
  const signature = digest(items.map(({ id, signature }) => [id, signature]));
  const added = items.filter(item => priorActive.get(item.id)?.signature !== item.signature);
  const ongoing = items.filter(item => priorActive.get(item.id)?.signature === item.signature);
  const resolved = ordered([...priorActive.values()].filter(item => !active.has(item.id)))
    .map(item => ({ ...item, recoveredAt: report.checkedAt || "", runKey }));
  const recovered = [...resolved, ...(previous?.summary?.recovered || [])]
    .filter((item, index, rows) => !active.has(item.id) && rows.findIndex(other => other.id === item.id) === index).slice(0, 30);
  const published = Boolean(previous?.summary?.published);
  const changed = published ? previous.summary.signature !== signature : items.length > 0 || resolved.length > 0;
  const sequence = (previous?.summary?.sequence || 0) + (changed ? 1 : 0);
  const summary = { changed, signature, added, ongoing, resolved, recovered, active: items,
    eventKey: digest([runKey, sequence, previous?.summary?.signature || "legacy", signature]) };
  state.summary = { signature, sequence, published: published || changed, active: items, recovered };
  return summary;
}

function safeText(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/@/g, "＠").replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}
function sourceLink(item) {
  let url;
  try { url = new URL(item.url); } catch (_) { return ""; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
  const target = url.href.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\|/g, "%7C");
  return `[${item.id === "market-forecast" ? "第三方来源" : "官方依据"}](${target})`;
}
function nextStep(item) {
  if (item.id === "market-forecast") return "Codex 核对估算来源、周期和时效；地区官方价独立更新。";
  if (item.type === "review") return item.detail.includes("系数") ?
    "Codex 查找有效官方系数或直接升价；依据不足时再请你决定来源或覆盖范围。" :
    "Codex 核对官方正文或附件，补齐解析与测试；依据缺失或冲突时再请求人工判断。";
  if (item.type === "validation") return "Codex 重放证据，检查地址、日期、单位及价区口径，修复适配并补充测试。";
  return "等待后续采集；持续失败时由 Codex 检查来源及传输，无需逐次人工核价。";
}
function renderSummary(summary, { runUrl, names = {}, legacy = [] } = {}) {
  const label = item => safeText(item.id === "market-forecast" ? "全国市场估算" : names[item.id] || item.id);
  function section(title, items, recovered = false) {
    if (!items.length) return `## ${title}\n\n暂无。`;
    return `## ${title}\n\n| 项目 | 原因与证据 | ${recovered ? "恢复日期" : "建议下一步"} |\n| --- | --- | --- |\n` +
      items.map(item => `| ${label(item)} | ${safeText(item.detail)} ${sourceLink(item)} | ${recovered ?
        safeText(item.recoveredAt || "见核价运行") : nextStep(item)} |`).join("\n");
  }
  return [SUMMARY_MARKER, `<!-- summary-state:${summary.signature} -->`, `<!-- summary-event:${summary.eventKey} -->`,
    "<!-- summary-notify:update -->", "# 核价异常事项汇总",
    `当前 ${summary.active.length} 项待处理；最近一次变化：新增或变化 ${summary.added.length} 项、持续 ${summary.ongoing.length} 项、已恢复 ${summary.resolved.length} 项。`,
    "这些是采集与核验待办，可以直接交给 Codex 排查。默认先由 Codex 重放证据、修复解析并验证；仅在官方依据缺失或冲突、来源及覆盖范围需要取舍时，再请求你的判断。当前流程只采集和提醒，不会自动启动 Codex 修改代码。",
    "无变化时不更新、不评论、不提醒。以下分类对应最近一次变化；持续次数、例行检查时间不触发通知。异常地区保留可信旧数据，季节系数失效时隐藏报价；全国市场估算保留原计算日期，跨周期隐藏。",
    section("新增或变化", summary.added), section("持续事项", summary.ongoing), section("已恢复（最近 30 项）", summary.recovered, true),
    runUrl ? `[最近变化的核价运行](${runUrl})` : "",
    legacy.length ? `历史地区 Issue：${legacy.map(issue => `[#${issue.number}](https://github.com/${issue.repository || ""}/issues/${issue.number})`).join("、")}。这些记录保持原样，仅供历史查询；后续只维护本汇总，不再逐价区创建、评论或关闭。` : ""
  ].filter(Boolean).join("\n\n");
}

async function deliver(plan, { token, repository, runUrl, names, fetcher = fetch } = {}) {
  if (!plan.summary.changed) return { changed: false };
  assert.ok(token && /^[\w.-]+\/[\w.-]+$/.test(repository), "缺少 GitHub 提醒配置");
  async function api(endpoint, method = "GET", value) {
    const response = await fetcher(`https://api.github.com/repos/${repository}${endpoint}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
        "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" },
      ...(value ? { body: JSON.stringify(value) } : {}), signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) throw new Error(`GitHub 异常汇总提醒失败：HTTP ${response.status}`);
    return response.json();
  }
  async function list(endpoint) {
    const values = [];
    for (let page = 1; ; page++) {
      const batch = await api(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      values.push(...batch);
      if (batch.length < 100) return values;
      assert.ok(page < 10, "未能完整读取核价汇总记录");
    }
  }
  const issues = (await list("/issues?state=all")).filter(issue => !issue.pull_request && issue.user?.login === "github-actions[bot]");
  const existing = issues.filter(issue => issue.body?.includes(SUMMARY_MARKER)).sort((a, b) => a.number - b.number)[0];
  const legacy = issues.filter(issue => /<!-- besfuel-data-alert:[a-z][a-z0-9-]* -->/.test(issue.body || ""))
    .map(issue => ({ number: issue.number, repository }));
  const title = "[油价核验] 异常事项汇总";
  const body = renderSummary(plan.summary, { runUrl, names, legacy });
  const owner = repository.split("/")[0];
  if (!existing) {
    const issue = await api("/issues", "POST", { title,
      body: body.replace("<!-- summary-notify:update -->", "<!-- summary-notify:create -->") +
        `\n\n@${owner}，已建立统一核价汇总，后续仅在事项变化时提醒。` });
    return { changed: true, created: true, issueNumber: issue.number };
  }
  const same = existing.body.includes(`<!-- summary-state:${plan.summary.signature} -->`);
  let eventKey = plan.summary.eventKey;
  if (same) {
    // Creation itself notifies. If an update only partly succeeded, use its
    // remote event key to finish the one comment, including from a later run.
    if (existing.body.includes("<!-- summary-notify:create -->")) return { changed: false, issueNumber: existing.number };
    eventKey = /<!-- summary-event:([a-f0-9]{64}) -->/.exec(existing.body)?.[1];
    assert.ok(eventKey, "汇总缺少远端变化标识");
  } else await api(`/issues/${existing.number}`, "PATCH", { title, body });
  const notification = `<!-- summary-notification:${eventKey} -->`;
  const comments = await list(`/issues/${existing.number}/comments`);
  if (comments.some(comment => comment.user?.login === "github-actions[bot]" && comment.body?.includes(notification))) {
    return { changed: false, issueNumber: existing.number };
  }
  await api(`/issues/${existing.number}/comments`, "POST", { body: `${notification}\n\n@${owner}，核价汇总有变化：` +
    `新增或变化 ${plan.summary.added.length} 项、持续 ${plan.summary.ongoing.length} 项、已恢复 ${plan.summary.resolved.length} 项。` +
    `\n\n[查看完整汇总](https://github.com/${repository}/issues/${existing.number})${runUrl ? ` · [核价运行](${runUrl})` : ""}` });
  return { changed: true, created: false, issueNumber: existing.number };
}

module.exports = { buildSummary, deliver, renderSummary, SUMMARY_MARKER };
