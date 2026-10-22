"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
async function readHunan(latest, reader, execute = promisify(execFile)) {
  const article = new URL(latest.url), attachment = new URL(latest.attachmentUrl);
  const match = article.pathname.match(/^(\/fgw\/(?:jggb11|xxgk_70899\/(?:gzdtf\/gzdt|tzgg))\/\d{6}\/)(?:t\d{8})_(\d+)\.html$/);
  assert.ok(match && article.protocol === "https:" && article.hostname === "fgw.hunan.gov.cn" &&
    attachment.origin === article.origin && !attachment.username && !attachment.password && !attachment.search && !attachment.hash &&
    attachment.pathname.startsWith(`${match[1]}${match[2]}/files/`) && /\/[a-f0-9]{32}\.xls$/.test(attachment.pathname), "湖南 XLS 附件与公告不匹配");
  const { buffer } = await reader.getBuffer(attachment.href);
  assert.ok(buffer.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex")), "湖南附件不是 XLS 工作簿");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "besfuel-xls-")), file = path.join(directory, "prices.xls");
  try {
    fs.writeFileSync(file, buffer);
    const result = await execute(process.env.BESFUEL_PYTHON || "python", [path.join(__dirname, "read-hunan-xls.py"), file, latest.publishedDate],
      { windowsHide: true, timeout: 20000, maxBuffer: 10000, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    return { ...latest, prices: JSON.parse(result.stdout), requiresManualLiterReview: false,
      attachmentSha256: crypto.createHash("sha256").update(buffer).digest("hex") };
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(directory);
  }
}
module.exports = { readHunan };
