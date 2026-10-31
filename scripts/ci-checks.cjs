"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");

function checksFor(phase, directory) {
  const unit = [
    { name: "node-tests", command: process.execPath, args: ["--test", "--test-reporter=tap",
      ...fs.readdirSync(path.join(directory, "tests")).filter(name => name.endsWith(".test.cjs")).sort().map(name => `tests/${name}`)] },
    { name: "python-tests", command: "python", args: ["-m", "unittest", "discover", "-s", "tests", "-p", "*_test.py"] },
    { name: "updater-tests", command: "powershell", args: ["-NoProfile", "-Command",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; " +
      "$ErrorActionPreference = 'Stop'; & .\\tests\\update-failure.ps1; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"] }
  ];
  const site = [
    { name: "validate-prices", command: process.execPath, args: ["scripts/validate-data.cjs"] },
    { name: "validate-crude", command: process.execPath, args: ["scripts/update-crude.cjs", "--validate"] },
    { name: "build", command: process.execPath, args: ["scripts/build-site.cjs"] },
    { name: "browser-smoke", command: process.execPath, args: ["tests/browser-smoke.cjs"],
      env: { BESFUEL_SITE_DIR: path.join(directory, "public") } }
  ];
  if (phase === "unit") return unit;
  if (phase === "site") return site;
  if (phase === "all") return [...unit, ...site];
  throw new Error(`Unknown check phase: ${phase}`);
}

async function runCheck(check, directory, logDirectory) {
  const logFile = `${check.name}.log`;
  const log = fs.createWriteStream(path.join(logDirectory, logFile));
  const started = Date.now();
  const exitCode = await new Promise(resolve => {
    const child = spawn(check.command, check.args, { cwd: directory,
      env: { ...process.env, ...check.env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      stream.on("data", chunk => { log.write(chunk); output.write(chunk); });
    }
    child.on("error", error => { log.write(`${error.message}\n`); });
    // close follows stdio drainage, including a failed process launch.
    child.on("close", code => resolve(Number.isInteger(code) ? code : 1));
  });
  await new Promise(resolve => log.end(resolve));
  return { name: check.name, outcome: exitCode === 0 ? "success" : "failure", exitCode,
    durationMs: Date.now() - started, logFile };
}

async function runChecks({ phase = "all", logDirectory, directory = root, checks = checksFor(phase, directory),
  summaryFile = process.env.GITHUB_STEP_SUMMARY }) {
  fs.mkdirSync(logDirectory, { recursive: true });
  const input = path.join(logDirectory, "input");
  fs.mkdirSync(input, { recursive: true });
  for (const name of ["prices.json", "prices.js", "crude-prices.json", "crude-prices.js"]) {
    const file = path.join(directory, "data", name);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(input, name));
  }
  const results = [];
  for (const check of checks) {
    if (results.some(result => result.outcome === "failure")) results.push({ name: check.name, outcome: "skipped" });
    else results.push(await runCheck(check, directory, logDirectory));
  }
  const report = { version: 1, phase, nodeVersion: process.version, revision: process.env.GITHUB_SHA || null, results };
  fs.writeFileSync(path.join(logDirectory, "checks.json"), JSON.stringify(report, null, 2) + "\n");
  if (summaryFile) {
    fs.appendFileSync(summaryFile, `\n### 检查结果（${phase}）\n\n` +
      "| 检查 | 结果 | 退出码 |\n| --- | --- | --- |\n" +
      results.map(result => `| ${result.name} | ${result.outcome} | ${result.exitCode ?? "—"} |`).join("\n") +
      "\n\n详细日志及本阶段输入快照见 CI diagnostics 产物。\n");
  }
  return report;
}

if (require.main === module) {
  const [phase, directory] = process.argv.slice(2);
  if (!directory) throw new Error("Usage: node scripts/ci-checks.cjs <unit|site|all> <log-directory>");
  runChecks({ phase, logDirectory: path.resolve(directory) }).then(report => {
    if (report.results.some(result => result.outcome === "failure")) process.exitCode = 1;
  }).catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { runChecks };
