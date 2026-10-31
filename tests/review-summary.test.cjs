"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { planAlerts, deliver, renderSummary, SUMMARY_MARKER } = require("../scripts/review-alerts.cjs");
const review = (id, url = `https://official.example/${id}`) => ({ id, ok: true, needsReview: true, latest: { url } });
const healthy = id => ({ id, ok: true });
const transient = id => ({ id, ok: false, error: "temporary socket detail", failure: { category: "timeout", url: `https://official.example/${id}` } });
const report = results => ({ version: 1, checkedAt: "2026-10-31", results });
const options = remote => ({ token: "test", repository: "owner/repo", runUrl: "https://github.com/owner/repo/actions/runs/1", fetcher: remote.fetcher });

function remoteStore(initial = []) {
  const issues = structuredClone(initial), comments = [], calls = [], faults = {};
  const response = value => ({ ok: true, json: async () => structuredClone(value) });
  const fetcher = async (url, args) => {
    const target = new URL(url), endpoint = target.pathname.replace("/repos/owner/repo", "");
    const value = args.body ? JSON.parse(args.body) : undefined;
    calls.push({ endpoint, method: args.method, value });
    const page = Number(target.searchParams.get("page") || 1);
    if (args.method === "GET" && endpoint === "/issues") return response(issues.slice((page - 1) * 100, page * 100));
    const match = /^\/issues\/(\d+)(\/comments)?$/.exec(endpoint);
    if (args.method === "GET" && match?.[2]) return response(comments.filter(item => item.issue === Number(match[1])).slice((page - 1) * 100, page * 100));
    if (args.method === "POST" && endpoint === "/issues") {
      const issue = { number: Math.max(0, ...issues.map(item => item.number)) + 1,
        user: { login: "github-actions[bot]" }, state: "open", ...value };
      issues.push(issue);
      if (faults.afterCreate) { faults.afterCreate = false; throw Error("lost creation response"); }
      return response(issue);
    }
    if (args.method === "PATCH" && match && !match[2]) {
      const issue = issues.find(item => item.number === Number(match[1]));
      assert.ok(issue); Object.assign(issue, value);
      if (faults.afterPatch) { faults.afterPatch = false; throw Error("lost update response"); }
      return response(issue);
    }
    if (args.method === "POST" && match?.[2]) {
      if (faults.beforeComment) { faults.beforeComment = false; return { ok: false, status: 503 }; }
      const comment = { id: comments.length + 1, issue: Number(match[1]), user: { login: "github-actions[bot]" }, ...value };
      comments.push(comment);
      if (faults.afterComment) { faults.afterComment = false; throw Error("lost comment response"); }
      return response(comment);
    }
    assert.fail(`Unexpected API request: ${args.method} ${endpoint}`);
  };
  return { issues, comments, calls, faults, fetcher, writes: () => calls.filter(call => call.method !== "GET") };
}

test("sixteen simultaneous problems create one summary and one owner mention", async () => {
  const results = Array.from({ length: 16 }, (_, index) => review(`region-${index}`));
  const plan = planAlerts(report(results), undefined, "1"), remote = remoteStore();
  await deliver(plan, options(remote));
  assert.equal(plan.summary.added.length, 16);
  assert.equal(remote.issues.length, 1);
  assert.equal(remote.comments.length, 0);
  assert.deepEqual(remote.writes().map(call => call.endpoint), ["/issues"]);
  assert.equal((remote.issues[0].body.match(/@owner/g) || []).length, 1);
  for (const item of results) assert.match(remote.issues[0].body, new RegExp(item.id));
});

test("unchanged problems, reordered checks and later counters make no GitHub requests", async () => {
  const first = planAlerts(report([review("hebei"), review("henan")]), undefined, "1");
  const next = planAlerts({ ...report([review("henan"), review("hebei")]), checkedAt: "2026-11-01" }, first.state, "2");
  assert.equal(next.state.entries.hebei.consecutive, 2);
  assert.equal(next.summary.changed, false);
  assert.equal(next.summary.signature, first.summary.signature);
  await deliver(next, { fetcher: () => assert.fail("An unchanged summary must not access GitHub") });
  const empty = planAlerts(report([healthy("hebei")]), undefined, "1");
  await deliver(empty, { fetcher: () => assert.fail("Healthy first run must stay quiet") });
});

test("a mixed change updates one issue and emits one aggregate comment", async () => {
  const remote = remoteStore();
  const first = planAlerts(report([review("hebei"), review("henan")]), undefined, "1");
  await deliver(first, options(remote));
  remote.calls.length = 0;
  const next = planAlerts(report([healthy("hebei"), review("henan"), review("hunan")]), first.state, "2");
  assert.deepEqual(next.summary.added.map(item => item.id), ["hunan"]);
  assert.deepEqual(next.summary.ongoing.map(item => item.id), ["henan"]);
  assert.deepEqual(next.summary.resolved.map(item => item.id), ["hebei"]);
  await deliver(next, options(remote));
  assert.equal(remote.issues.length, 1);
  assert.equal(remote.comments.length, 1);
  assert.deepEqual(remote.writes().map(call => [call.method, call.endpoint]), [["PATCH", "/issues/1"], ["POST", "/issues/1/comments"]]);
  assert.doesNotMatch(remote.issues[0].body, /@owner/);
  for (const heading of ["新增或变化", "持续事项", "已恢复"]) assert.match(remote.issues[0].body, new RegExp(heading));
  assert.match(remote.comments[0].body, /@owner.*新增或变化 1 项、持续 1 项、已恢复 1 项/);
});

test("new evidence alerts once, all recovery reuses the tracker, and recurrence alerts again", async () => {
  const remote = remoteStore();
  const first = planAlerts(report([review("hebei")]), undefined, "1");
  await deliver(first, options(remote));
  const changed = planAlerts(report([review("hebei", "https://official.example/new")]), first.state, "2");
  assert.equal(changed.summary.added.length, 1);
  await deliver(changed, options(remote));
  const recovered = planAlerts(report([healthy("hebei")]), changed.state, "3");
  await deliver(recovered, options(remote));
  assert.equal(remote.issues[0].state, "open");
  assert.equal(recovered.summary.active.length, 0);
  assert.match(remote.issues[0].body, /当前 0 项待处理/);
  const quiet = planAlerts(report([healthy("hebei")]), recovered.state, "4");
  assert.equal(quiet.summary.changed, false);
  const recurrent = planAlerts(report([review("hebei")]), quiet.state, "5");
  assert.equal(recurrent.summary.added.length, 1);
  assert.equal(recurrent.summary.recovered.length, 0);
  await deliver(recurrent, options(remote));
  assert.equal(remote.issues.length, 1);
  assert.equal(remote.comments.length, 3);
});

test("transient failures wait three different runs and cannot falsely resolve an active problem", () => {
  let plan = planAlerts(report([transient("henan")]), undefined, "1");
  assert.equal(plan.summary.changed, false);
  plan = planAlerts(report([transient("henan")]), plan.state, "1");
  assert.equal(plan.state.entries.henan.consecutive, 1);
  plan = planAlerts(report([transient("henan")]), plan.state, "2");
  assert.equal(plan.summary.changed, false);
  plan = planAlerts(report([transient("henan")]), plan.state, "3");
  assert.equal(plan.summary.added.length, 1);
  const first = planAlerts(report([review("hebei")]), undefined, "1");
  const pending = planAlerts(report([transient("hebei")]), first.state, "2");
  assert.equal(pending.summary.changed, false);
  assert.deepEqual(pending.summary.active, first.summary.active);
  assert.equal(pending.summary.resolved.length, 0);
  const absent = planAlerts(report([]), pending.state, "3");
  assert.equal(absent.summary.changed, false);
  const recovered = planAlerts(report([healthy("hebei")]), absent.state, "4");
  assert.equal(recovered.summary.resolved.length, 1);
});

test("repeated material transitions under the same workflow run still notify once per change", async () => {
  const remote = remoteStore();
  let state;
  for (const path of ["original", "revised", "original", "revised"]) {
    const plan = planAlerts(report([review("hebei", `https://official.example/${path}`)]), state, "same-run");
    await deliver(plan, options(remote));
    state = plan.state;
  }
  assert.equal(state.summary.sequence, 4);
  assert.equal(remote.issues.length, 1);
  assert.equal(remote.comments.length, 3);
  assert.equal(new Set(remote.comments.map(comment => comment.body.split("\n")[0])).size, 3);
});

test("old per-region reminders migrate once without modifying legacy issues", async () => {
  const checks = Array.from({ length: 16 }, (_, index) => review(`region-${index}`));
  const previous = planAlerts(report(checks), undefined, "old").state;
  delete previous.summary;
  for (const entry of Object.values(previous.entries)) delete entry.problem;
  const legacy = checks.map((item, index) => ({ number: index + 1, user: { login: "github-actions[bot]" },
    state: "open", body: `<!-- besfuel-data-alert:${item.id} -->` }));
  const remote = remoteStore(legacy), plan = planAlerts(report(checks), previous, "new");
  assert.equal(plan.summary.added.length, 0);
  assert.equal(plan.summary.ongoing.length, 16);
  assert.equal(plan.summary.changed, true);
  await deliver(plan, options(remote));
  assert.deepEqual(remote.issues.slice(0, 16), legacy);
  assert.equal(remote.issues.length, 17);
  assert.equal(remote.writes().length, 1);
  assert.match(remote.issues[16].body, /历史地区 Issue/);
  assert.equal(planAlerts(report(checks), plan.state, "later").summary.changed, false);
});

test("lost creation responses and saved-state failures cannot create duplicate trackers", async () => {
  const remote = remoteStore(), plan = planAlerts(report([review("hebei")]), undefined, "1");
  remote.faults.afterCreate = true;
  await assert.rejects(deliver(plan, options(remote)), /lost creation/);
  await deliver(plan, options(remote));
  const later = planAlerts(report([review("hebei")]), undefined, "later");
  await deliver(later, options(remote));
  assert.equal(remote.issues.length, 1);
  assert.equal(remote.comments.length, 0);
  assert.equal(remote.writes().length, 1);
});

for (const fault of ["afterPatch", "beforeComment", "afterComment"]) {
  test(`an interrupted ${fault} retries the same remote event without duplicate notifications`, async () => {
    const remote = remoteStore();
    const first = planAlerts(report([review("hebei")]), undefined, "1");
    await deliver(first, options(remote));
    const changedReport = report([review("hebei"), review("henan")]);
    const next = planAlerts(changedReport, first.state, "2");
    remote.faults[fault] = true;
    await assert.rejects(deliver(next, options(remote)));
    const later = planAlerts(changedReport, first.state, "3");
    await deliver(later, options(remote));
    await deliver(later, options(remote));
    assert.equal(remote.issues.length, 1);
    assert.equal(remote.comments.length, 1);
    assert.equal(remote.calls.filter(call => call.method === "PATCH").length, 1);
    assert.ok(remote.comments[0].body.includes(next.summary.eventKey));
    assert.notEqual(later.summary.eventKey, next.summary.eventKey);
  });
}

test("pagination finds an existing closed tracker and ignores markers from other authors", async () => {
  const first = planAlerts(report([review("hebei")]), undefined, "1");
  const issues = Array.from({ length: 100 }, (_, index) => ({ number: index + 1,
    user: { login: "someone-else" }, body: SUMMARY_MARKER }));
  issues.push({ number: 101, user: { login: "github-actions[bot]" }, state: "closed",
    body: renderSummary(first.summary).replace("<!-- summary-notify:update -->", "<!-- summary-notify:create -->") });
  const remote = remoteStore(issues);
  const next = planAlerts(report([review("henan"), healthy("hebei")]), first.state, "2");
  await deliver(next, options(remote));
  assert.equal(remote.issues.length, 101);
  assert.equal(remote.issues[100].state, "closed", "do not add reopen or close notifications");
  assert.equal(remote.comments[0].issue, 101);
  assert.equal(remote.calls.filter(call => call.endpoint === "/issues" && call.method === "GET").length, 2);
});

test("rendering gives Codex next steps and prevents source content from mentioning other users", () => {
  const plan = planAlerts(report([{ id: "hebei", ok: false, error: "bad | header @someone <tag>",
    failure: { category: "validation", url: "javascript:alert(1)" } },
  { id: "heilongjiang-north", ok: true, needsReview: true, latest: { requiresManualCoefficientReview: true } }]), undefined, "1");
  const body = renderSummary(plan.summary);
  assert.match(body, /Codex 重放证据/);
  assert.match(body, /查找有效官方系数/);
  assert.match(body, /＠someone/);
  assert.doesNotMatch(body, /@someone|<tag>|javascript:/);
  assert.throws(() => planAlerts(report([healthy("hebei"), healthy("hebei")]), undefined, "1"), /项目重复/);
});
