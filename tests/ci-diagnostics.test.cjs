"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runChecks } = require("../scripts/ci-checks.cjs");

test("CI preserves failed output, exit status and skipped checks for diagnosis", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "besfuel-ci-log-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const summaryFile = path.join(directory, "summary.md");
  const report = await runChecks({ directory, logDirectory: directory, phase: "unit", summaryFile, checks: [
    { name: "passed", command: process.execPath, args: ["-e", "console.log('passed marker')"] },
    { name: "failed", command: process.execPath, args: ["-e", "console.error('failure marker'); process.exitCode = 7"] },
    { name: "later", command: process.execPath, args: ["-e", "process.exitCode = 99"] }
  ] });
  assert.deepEqual(report.results.map(result => result.outcome), ["success", "failure", "skipped"]);
  assert.equal(report.results[1].exitCode, 7);
  assert.match(fs.readFileSync(path.join(directory, "failed.log"), "utf8"), /failure marker/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, "checks.json"), "utf8")), report);
  assert.equal(fs.existsSync(path.join(directory, "later.log")), false);
  assert.match(fs.readFileSync(summaryFile, "utf8"), /failed \| failure \| 7/);
});

test("CI records an unavailable command as a failed check", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "besfuel-ci-launch-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const report = await runChecks({ directory, logDirectory: directory, summaryFile: null, checks: [
    { name: "missing", command: path.join(directory, "unavailable-command.exe"), args: [] }
  ] });
  assert.equal(report.results[0].outcome, "failure");
  assert.match(fs.readFileSync(path.join(directory, "missing.log"), "utf8"), /ENOENT/);
});
