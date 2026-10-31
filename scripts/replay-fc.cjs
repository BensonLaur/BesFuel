"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runChecks } = require("./ci-checks.cjs");
const { runAutomatic } = require("./automatic-review.cjs");
const { writeSnapshot, chinaDate } = require("./update-regions.cjs");
const { importVerified } = require("./import-verified.cjs");
const { siteFiles } = require("./build-site.cjs");

const root = path.resolve(__dirname, "..");

async function main() {
  const [bundleFile, baselineFile, outputDirectory] = process.argv.slice(2);
  if (!bundleFile || !baselineFile) throw new Error(
    "Usage: node scripts/replay-fc.cjs <fc-regions.json> <prices-before.json> [empty-output-directory]");
  const bundle = JSON.parse(fs.readFileSync(bundleFile, "utf8"));
  const initial = JSON.parse(fs.readFileSync(baselineFile, "utf8"));
  const directory = outputDirectory ? path.resolve(outputDirectory) : fs.mkdtempSync(path.join(os.tmpdir(), "besfuel-replay-"));
  const relative = path.relative(root, directory);
  if (!relative || (!relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))) {
    throw new Error("Replay output must be outside the working repository");
  }
  if (fs.existsSync(directory) && fs.readdirSync(directory).length) throw new Error(`Output directory must be empty: ${directory}`);
  fs.mkdirSync(directory, { recursive: true });
  console.log(`隔离重放目录：${directory}`);
  for (const name of ["scripts", "tests", "lib", "data", "cloud", "resources"]) {
    fs.cpSync(path.join(root, name), path.join(directory, name), { recursive: true });
  }
  for (const name of new Set(["package.json", "package-lock.json", ...siteFiles.filter(file => !file.includes("/"))])) {
    fs.copyFileSync(path.join(root, name), path.join(directory, name));
  }
  // Child tests can use installed dependencies without copying node_modules or
  // writing to the working repository. No source collection uses the network.
  process.env.NODE_PATH = [path.join(root, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  const json = path.join(directory, "data/prices.json"), js = path.join(directory, "data/prices.js");
  writeSnapshot(initial, json, js);
  const diagnostics = path.join(directory, "diagnostics");
  const before = await runChecks({ directory, phase: "all", logDirectory: path.join(diagnostics, "before"), summaryFile: null });
  assert.ok(before.results.every(result => result.outcome === "success"), "采集前检查失败，见 diagnostics/before");
  const offline = async () => { throw new Error("Offline replay: source bytes must come from the supplied FC artifact"); };
  // Freeze the age check at capture time; the original timestamps and integrity
  // checks remain intact, even when investigating an old artifact months later.
  const options = { bundle, now: new Date(bundle.generatedAt), today: chinaDate(new Date(bundle.generatedAt)),
    reader: () => ({ getText: offline, getBuffer: offline }) };
  const result = await runAutomatic({ ...options, initial });
  const repeated = await runAutomatic({ ...options, initial: result.data });
  assert.deepEqual(repeated.data, result.data, "同一 FC 产物重复应用必须幂等");
  const rollback = [];
  for (const [id, region] of Object.entries(result.data.regions)) {
    const prior = initial.regions[id];
    const recordFile = path.join(root, "data/verified", `${id}.json`);
    if (!prior || region.grades["92"].history.at(-1).date <= prior.grades["92"].history.at(-1).date || !fs.existsSync(recordFile)) continue;
    const record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
    if (record.notices.at(-1).effectiveDate >= region.grades["92"].history.at(-1).date) continue;
    const trusted = JSON.stringify(result.data);
    assert.throws(() => importVerified(result.data, record), /官方列表比已保存的可信价格旧/);
    assert.equal(JSON.stringify(result.data), trusted, `${id}: 被拒绝的导入不得修改快照`);
    rollback.push({ id, oldDate: record.notices.at(-1).effectiveDate,
      retainedDate: region.grades["92"].history.at(-1).date, outcome: "rejected" });
  }
  writeSnapshot(result.data, json, js);
  fs.copyFileSync(bundleFile, path.join(diagnostics, "fc-regions.json"));
  fs.writeFileSync(path.join(diagnostics, "replay.json"), JSON.stringify({ generatedAt: bundle.generatedAt,
    sources: result.sources, monitors: result.monitors, direct: result.direct, rollback, idempotent: true }, null, 2));
  const after = await runChecks({ directory, phase: "all", logDirectory: path.join(diagnostics, "after"), summaryFile: null });
  assert.ok(after.results.every(result => result.outcome === "success"), "采集后检查失败，见 diagnostics/after");
  console.log(`FC 产物完整重放通过；${rollback.length} 个地区拒绝旧价格覆盖；诊断：${diagnostics}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
