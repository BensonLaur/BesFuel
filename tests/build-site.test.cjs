const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildSite, validateSiteData } = require("../scripts/build-site.cjs");

test("Pages artifact contains local HTML resources and matching JSON/offline snapshots", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "besfuel-site-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  buildSite(directory);
  const html = fs.readFileSync(path.join(directory, "index.html"), "utf8");
  for (const [, file] of html.matchAll(/(?:src|href)="([^"#:]+\.(?:js|css|png))"/g)) {
    assert.ok(fs.existsSync(path.join(directory, file)), `packaged resource: ${file}`);
  }
  for (const file of [".nojekyll", "resources/support/wechat.png", "resources/support/alipay.png"]) {
    assert.ok(fs.existsSync(path.join(directory, file)));
  }
  assert.equal(fs.existsSync(path.join(directory, "scripts")), false);
  assert.equal(fs.existsSync(path.join(directory, ".git")), false);
  validateSiteData(directory);
  fs.writeFileSync(path.join(directory, "data/crude-prices.js"), "window.BESFUEL_CRUDE_DATA = {};\r\n");
  assert.throws(() => validateSiteData(directory), /不一致/);
});
