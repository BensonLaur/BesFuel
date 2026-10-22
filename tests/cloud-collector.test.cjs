"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { Readable } = require("node:stream");
const { collectBundle, applyBundle, validateBundle, MAX_BYTES } = require("../scripts/cloud-bundle.cjs");
const { counts } = require("../scripts/source-health.cjs");
const { createStore } = require("../scripts/cloud-storage.cjs");
const { configuration } = require("../scripts/fc-config.cjs");
const { execute } = require("../cloud/fc/index.cjs");
const { createServer } = require("../cloud/fc/server.cjs");
const { importFile } = require("../scripts/import-cloud.cjs");
const { writeSnapshot } = require("../scripts/update-regions.cjs");
const initial = require("../data/prices.json");
const now = new Date(`${initial.checkedAt}T04:00:00.000Z`);
const revision = "a".repeat(40);
const source = require("../scripts/sources/beijing.cjs");
const monitor = require("../scripts/monitors/anhui.cjs");

function previousDate(date) { return new Date(Date.parse(date) - 86400000).toISOString().slice(0, 10); }
function notice(id) {
  const region = initial.regions[id];
  return { url: region.source.url, effectiveDate: region.grades["92"].history.at(-1).date,
    publishedDate: previousDate(region.grades["92"].history.at(-1).date),
    prices: Object.fromEntries(["92", "95", "diesel"].map(grade => [grade, region.grades[grade].price])) };
}
async function fixture(extraSources = []) {
  const sources = [{ ...source, collect: async () => [notice(source.id)] }, ...extraSources];
  const monitors = [{ ...monitor, collect: async () => notice(monitor.id) }];
  const bundle = await collectBundle({ initial, sources, monitors, revision, now: () => now, reader: () => ({}) });
  return { bundle, options: { sources, monitors, now } };
}

test("FC results replay on the current snapshot without replacing manual or unrelated data", async () => {
  const { bundle, options } = await fixture();
  const current = structuredClone(initial);
  current.regions.anhui.name = "安徽（人工核验后的名称）";
  const result = applyBundle(JSON.parse(JSON.stringify(bundle)), current, options);
  assert.equal(result.data.regions.anhui.name, current.regions.anhui.name);
  assert.deepEqual(result.data.regions.guangdong, current.regions.guangdong);
  assert.deepEqual(result.data.nationalAdjustment, current.nationalAdjustment);
  assert.equal(result.sources[0].count, 1);
  assert.equal(result.monitors[0].needsReview, false);
  assert.deepEqual(current.regions.beijing, initial.regions.beijing);
});

test("a failed FC region retains its trusted data while another region can update", async () => {
  const failed = { ...require("../scripts/sources/guangxi.cjs"), collect: async () => { throw new Error("network unavailable"); } };
  const { bundle, options } = await fixture([failed]);
  const result = applyBundle(bundle, initial, options);
  assert.equal(result.sources.find(item => item.id === "guangxi").ok, false);
  assert.deepEqual(result.data.regions.guangxi, initial.regions.guangxi);
  assert.equal(bundle.counts.sources.failed, 1);
});

test("new manual decisions are evaluated again instead of trusting FC needsReview", async () => {
  const { bundle, options } = await fixture();
  const current = structuredClone(initial);
  // The notice was corrected after the packaged baseline: the price must be reviewed again.
  bundle.monitors[0].latest.prices["92"] += 0.01;
  assert.equal(bundle.monitors[0].needsReview, false);
  const result = applyBundle(bundle, current, options);
  assert.equal(result.monitors[0].needsReview, true);
  assert.deepEqual(result.data.regions.anhui, current.regions.anhui);
});

test("FC import refuses stale, future, mismatched, incomplete and conflicting evidence", async () => {
  const { bundle, options } = await fixture();
  const mutations = [
    value => { value.startedAt = new Date(now.getTime() - 19 * 3600000).toISOString(); value.generatedAt = value.startedAt; },
    value => { value.startedAt = new Date(now.getTime() + 600000).toISOString(); value.generatedAt = value.startedAt; },
    value => { value.adapterDigest = "0".repeat(64); },
    value => { value.sources = []; },
    value => { value.sources.push(structuredClone(value.sources[0])); },
    value => { value.counts.sources.passed = 90; },
    value => { value.sources[0].notices[0].url = "https://untrusted.example/price"; },
    value => { value.sources[0].notices[0].prices["92"] = -1; },
    value => { value.monitors[0].latest.publishedDate = "2026-02-31"; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(bundle); mutate(changed);
    assert.throws(() => applyBundle(changed, initial, options));
  }
  const conflicting = structuredClone(bundle);
  conflicting.sources[0].notices[0].prices["92"] += 0.01;
  assert.throws(() => applyBundle(conflicting, initial, options), /冲突/);
});

test("unchanged notices survive JSON transport and price history is not duplicated", async () => {
  const nmg = require("../scripts/sources/inner-mongolia-east.cjs");
  const snapshot = structuredClone(initial), old = snapshot.regions[nmg.id];
  const notices = [notice(nmg.id)];
  notices.latestNotice = old.latestNotice;
  const sources = [{ ...nmg, collect: async () => notices }];
  const bundle = await collectBundle({ initial: snapshot, sources, monitors: [], revision, now: () => now, reader: () => ({}) });
  const received = JSON.parse(JSON.stringify(bundle));
  const result = applyBundle(received, snapshot, { sources, monitors: [], now });
  assert.deepEqual(result.data.regions[nmg.id].latestNotice, old.latestNotice);
  assert.deepEqual(result.data.regions[nmg.id].grades, old.grades);
});

const env = { BESFUEL_OSS_BUCKET: "besfuel-test-bucket" };
test("OSS stores immutable private-bucket results and selects newest start time", async () => {
  const objects = new Map();
  const client = {
    async put(key, body, { headers }) {
      assert.equal(headers["x-oss-forbid-overwrite"], "true");
      assert.equal(headers["If-Match"], undefined);
      assert.equal(headers["x-oss-object-acl"], undefined);
      objects.set(key, body);
    },
    async listV2({ prefix }) { return { objects: [...objects.keys()].map(name => ({ name })), isTruncated: false }; },
    async getStream(key) { return { stream: Readable.from([objects.get(key)]), res: { headers: {} } }; }
  };
  const store = createStore({ env, client });
  await store.publish({ startedAt: "2026-10-22T12:00:00.000Z", value: "newer" });
  await store.publish({ startedAt: "2026-10-22T02:00:00.000Z", value: "older" });
  const result = await store.read();
  assert.equal(JSON.parse(result.body).value, "newer");
  assert.equal(objects.size, 2);
  await assert.rejects(store.publish({ startedAt: now.toISOString(), value: "x".repeat(MAX_BYTES) }), /大小上限/);
});

test("OSS refuses oversized responses and incomplete listings, and does not log credentials", async () => {
  const name = "regions/20261022T120000000Z-12345678-1234-1234-1234-123456789abc.json";
  const store = createStore({ env, client: {
    listV2: async () => ({ objects: [{ name }] }),
    getStream: async () => ({ stream: Readable.from([Buffer.alloc(MAX_BYTES + 1)]), res: { headers: {} } })
  } });
  await assert.rejects(store.read(), /大小上限/);
  await assert.rejects(createStore({ env, client: { listV2: async () => ({ isTruncated: true }) } }).read(), /生命周期/);
  await assert.rejects(createStore({ env, client: { listV2: async () => {
    throw Object.assign(new Error("secret credential must not leak"), { code: "AccessDenied", status: 403 });
  } } }).read(), error => error.message.includes("AccessDenied") && !error.message.includes("secret credential"));
});

test("FC validates events before collecting and persists partial source reports", async () => {
  let called = 0;
  const { bundle } = await fixture();
  bundle.sources[0] = { id: source.id, ok: false, error: "source unavailable" };
  bundle.counts.sources = counts(bundle.sources);
  const result = await execute({}, {}, { revision, collect: async () => bundle,
    store: { publish: async value => { called++; assert.equal(value, bundle); return { written: true }; } } });
  assert.equal(result.healthy, false);
  assert.equal(called, 1);
  await assert.rejects(execute({ requestContext: {} }, {}, { collect: () => assert.fail("must reject HTTP events") }), /HTTP/);
  await assert.rejects(execute({ mode: "unknown" }, {}, {}), /模式/);
});

test("custom runtime forwards temporary credentials and signals invocation errors to FC", async t => {
  const server = createServer(async (body, context) => {
    assert.equal(context.credentials.securityToken, "temporary-test-token");
    if (JSON.parse(body).fail) throw new Error("mock storage failure");
    return { ok: true };
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/invoke`;
  const options = { method: "POST", headers: { "x-fc-access-key-id": "temporary-test-id",
    "x-fc-access-key-secret": "temporary-test-secret", "x-fc-security-token": "temporary-test-token" } };
  const ok = await fetch(url, { ...options, body: "{}" });
  assert.equal(ok.headers.get("x-fc-status"), "200");
  assert.deepEqual(await ok.json(), { ok: true });
  const failed = await fetch(url, { ...options, body: '{"fail":true}' });
  assert.equal(failed.status, 500);
  assert.equal(failed.headers.get("x-fc-status"), "404");
  assert.deepEqual(await failed.json(), { error: "mock storage failure" });
});

test("Debian 11 invocations use complete role credentials from the environment", async t => {
  const runtimeEnv = { ALIBABA_CLOUD_ACCESS_KEY_ID: "environment-test-id",
    ALIBABA_CLOUD_ACCESS_KEY_SECRET: "environment-test-secret", ALIBABA_CLOUD_SECURITY_TOKEN: "environment-test-token" };
  const server = createServer(async (body, context) => {
    assert.deepEqual(context.credentials, { accessKeyId: runtimeEnv.ALIBABA_CLOUD_ACCESS_KEY_ID,
      accessKeySecret: runtimeEnv.ALIBABA_CLOUD_ACCESS_KEY_SECRET, securityToken: runtimeEnv.ALIBABA_CLOUD_SECURITY_TOKEN });
    // Construct the real OSS client without sending a network request. Missing
    // role credentials must fail before collection or publishing begins.
    createStore({ env, credentials: context.credentials });
    return { ok: true };
  }, { env: runtimeEnv });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/invoke`;
  const invoke = headers => fetch(url, { method: "POST", headers, body: "{}" });
  for (const headers of [{}, { "x-fc-access-key-id": "other-session-id", "x-fc-access-key-secret": "other-session-secret" }]) {
    const result = await invoke(headers);
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { ok: true });
  }
  // A warm server resolves credentials per invocation instead of capturing them at startup.
  runtimeEnv.ALIBABA_CLOUD_SECURITY_TOKEN = "renewed-environment-token";
  assert.equal((await invoke({})).status, 200);
  delete runtimeEnv.ALIBABA_CLOUD_SECURITY_TOKEN;
  const missing = await invoke({});
  assert.equal(missing.status, 500);
  assert.equal(missing.headers.get("x-fc-status"), "404");
  const error = (await missing.json()).error;
  assert.match(error, /缺少临时 OSS 凭证/);
  assert.ok(!error.includes(runtimeEnv.ALIBABA_CLOUD_ACCESS_KEY_SECRET));
});

test("invalid cloud file leaves both browser and JSON snapshots untouched", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "besfuel-import-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, "data"));
  const json = path.join(directory, "data/prices.json"), js = path.join(directory, "data/prices.js");
  writeSnapshot(initial, json, js);
  const original = [fs.readFileSync(json), fs.readFileSync(js)];
  const input = path.join(directory, "cloud.json"); fs.writeFileSync(input, '{"format":"bad"}');
  assert.throws(() => importFile(input, { root: directory }), /格式/);
  assert.deepEqual([fs.readFileSync(json), fs.readFileSync(js)], original);
});

test("generated policies scope cloud writes and GitHub reads to the dedicated prefix", () => {
  const config = configuration("1234567890123456", "besfuel-test-bucket");
  assert.deepEqual(config["fc-oss-policy.json"].Statement[0].Action, ["oss:PutObject"]);
  assert.deepEqual(config["github-oss-policy.json"].Statement[0].Action, ["oss:GetObject"]);
  assert.equal(config["github-role-trust.json"].Statement[0].Condition.StringEquals["oidc:sub"], "repo:BensonLaur/BesFuel:ref:refs/heads/main");
  assert.equal(config["deployment.json"].minimumInstances, 0);
  assert.throws(() => configuration("1234567890123456", "bucket/escape"));
});
