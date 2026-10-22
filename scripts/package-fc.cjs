"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { adapterDigest } = require("./cloud-bundle.cjs");
const root = path.resolve(__dirname, "..");
const version = "22.23.3";
// Official nodejs.org/dist/v22.23.3/SHASUMS256.txt; updates must change both values.
const archiveHash = "df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de";
function build(output) {
  if (!output) throw new Error("Usage: node scripts/package-fc.cjs OUTPUT_DIRECTORY");
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  if (dirty.trim()) throw new Error("请先提交当前代码，再生成带准确版本的 FC 部署包");
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const destination = path.resolve(output);
  if (fs.existsSync(destination)) throw new Error("输出目录已存在，请指定新的目录");
  const stage = path.join(destination, "package");
  fs.mkdirSync(stage, { recursive: true });
  const files = ["package.json", "package-lock.json", "data/prices.json", "data/verified", "cloud/fc", "scripts/sources", "scripts/monitors",
    ...["cloud-bundle", "cloud-storage", "cloud-extra", "automatic-tables", "source-health", "source-errors", "source-transport", "update-regions", "check-monitors", "validate-data", "nmg-unchanged"].map(name => `scripts/${name}.cjs`)];
  for (const file of files) {
    const target = path.join(stage, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.join(root, file), target, { recursive: true });
  }
  // Install from the lock without running dependency lifecycle scripts. All
  // runtime dependencies are JavaScript; no Windows native binaries are shipped.
  const npm = process.platform === "win32" ? "cmd.exe" : "npm";
  const args = process.platform === "win32" ? ["/d", "/c", "npm ci --omit=dev --ignore-scripts"] : ["ci", "--omit=dev", "--ignore-scripts"];
  execFileSync(npm, args, { cwd: stage, stdio: "inherit", windowsHide: true });
  const archiveName = `node-v${version}-linux-x64.tar.xz`;
  const archive = path.join(os.tmpdir(), archiveName);
  if (!fs.existsSync(archive)) execFileSync(process.platform === "win32" ? "curl.exe" : "curl",
    ["--fail", "--silent", "--show-error", "--location", "--max-time", "180", "--output", archive, `https://nodejs.org/dist/v${version}/${archiveName}`],
    { stdio: "inherit", windowsHide: true, timeout: 190000 });
  const digest = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  if (digest !== archiveHash) throw new Error(`Node.js 归档校验失败，请检查临时文件 ${archive}`);
  const extract = path.join(destination, "runtime-extract"); fs.mkdirSync(extract);
  execFileSync("tar", ["-xf", archive, "-C", extract, `node-v${version}-linux-x64/bin/node`, `node-v${version}-linux-x64/LICENSE`], { windowsHide: true });
  fs.mkdirSync(path.join(stage, "runtime"));
  fs.copyFileSync(path.join(extract, `node-v${version}-linux-x64/bin/node`), path.join(stage, "runtime/node"));
  fs.copyFileSync(path.join(extract, `node-v${version}-linux-x64/LICENSE`), path.join(stage, "runtime/LICENSE"));
  fs.writeFileSync(path.join(stage, "cloud/fc/REVISION"), revision + "\r\n");
  const zip = path.join(destination, "besfuel-fc-collector.zip");
  execFileSync(process.platform === "win32" ? "python" : "python3", [path.join(__dirname, "zip-fc.py"), stage, zip], { stdio: "inherit", windowsHide: true });
  const manifest = { revision, adapterDigest: adapterDigest(), node: version, nodeArchiveSha256: archiveHash,
    packageSha256: crypto.createHash("sha256").update(fs.readFileSync(zip)).digest("hex"), bytes: fs.statSync(zip).size };
  fs.writeFileSync(path.join(destination, "manifest.json"), JSON.stringify(manifest, null, 2).replace(/\n/g, "\r\n") + "\r\n");
  console.log(JSON.stringify({ ...manifest, zip }));
  return zip;
}
if (require.main === module) {
  try { build(process.argv[2]); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { build };
