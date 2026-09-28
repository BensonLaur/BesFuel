const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { calculate } = require("../lib/calc.js");

const root = path.resolve(__dirname, "..");
const snapshot = JSON.parse(fs.readFileSync(path.join(root, "data", "prices.json"), "utf8"));
const guangdong = snapshot.regions.guangdong;
const expectedTotal = price => calculate("9", "9", String(price)).total.toFixed(2);
const edge = process.env.BROWSER_PATH || path.join(process.env["PROGRAMFILES(X86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, socket, profile, server;

async function main() {
  if (!fs.existsSync(edge)) throw new Error("Set BROWSER_PATH to a Chromium-based browser executable.");
  profile = fs.mkdtempSync(path.join(os.tmpdir(), "besfuel-smoke-"));
  browser = spawn(edge, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-extensions", "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", windowsHide: true });
  let launchError;
  browser.on("error", error => { launchError = error; });
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (launchError) throw launchError;
    const activePort = path.join(profile, "DevToolsActivePort");
    if (fs.existsSync(activePort)) { port = Number(fs.readFileSync(activePort, "utf8").split(/\r?\n/)[0]); break; }
    await delay(100);
  }
  if (!port) throw new Error("Browser debugging endpoint did not start.");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find(target => target.type === "page");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

  let nextId = 0;
  const pending = new Map();
  const errors = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(message.error) : resolve(message.result);
    }
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
  };
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return response.result.value;
  }
  async function setValue(id, value, eventName) {
    await evaluate(`(() => { const element = document.getElementById(${JSON.stringify(id)}); element.value = ${JSON.stringify(value)}; element.dispatchEvent(new Event(${JSON.stringify(eventName)}, { bubbles: true })); })()`);
  }
  async function waitForSupportImage() {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await evaluate("document.getElementById('support-image').naturalWidth > 0")) return;
      await delay(100);
    }
    throw new Error("Support image did not load.");
  }

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Network.enable");
  await send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 1500, deviceScaleFactor: 1, mobile: true });
  await send("Page.navigate", { url: pathToFileURL(path.join(root, "index.html")).href });
  await send("Page.bringToFront");
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await evaluate("document.getElementById('current-price')?.textContent") === guangdong.grades["92"].price.toFixed(2)) break;
    await delay(100);
  }
  assert.equal(await evaluate("document.getElementById('current-price').textContent"), guangdong.grades["92"].price.toFixed(2));
  assert.equal(await evaluate("document.getElementById('region-label').textContent"), "广东");
  assert.equal(await evaluate("document.getElementById('region').selectedOptions[0].textContent"), "广东");
  assert.equal(await evaluate("document.querySelectorAll('.chart-point').length"), guangdong.grades["92"].history.length);
  assert.equal(await evaluate("document.querySelectorAll('.chart-hit').length"), guangdong.grades["92"].history.length);
  assert.ok(await evaluate("(() => { const line = document.querySelector('.chart-latest-line'); const point = [...document.querySelectorAll('.chart-point')].at(-1); return line && point && line.getAttribute('y1') === point.getAttribute('cy') && line.getAttribute('y2') === point.getAttribute('cy'); })()"), "latest price line must align with the latest point");
  await evaluate("document.querySelectorAll('.chart-hit')[3].dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }))");
  assert.equal(await evaluate("document.querySelector('.chart-tooltip').textContent"), `${guangdong.grades["92"].history[3].date} 生效${guangdong.grades["92"].history[3].price.toFixed(2)} 元/升`);
  await evaluate("document.querySelectorAll('.chart-hit')[3].dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }))");
  assert.ok(await evaluate("document.querySelector('.chart-tooltip').hidden"));
  await evaluate("document.querySelectorAll('.chart-hit')[0].focus()");
  assert.ok(await evaluate(`document.querySelector('.chart-tooltip').textContent.includes(${JSON.stringify(guangdong.grades["92"].history[0].date)})`));
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
  assert.equal(await evaluate("document.activeElement.getAttribute('class')"), "chart-hit");
  assert.ok(await evaluate(`document.querySelector('.chart-tooltip').textContent.includes(${JSON.stringify(guangdong.grades["92"].history[1].date)})`));
  await evaluate("document.querySelectorAll('.chart-hit')[6].dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'touch' }))");
  await evaluate("document.querySelectorAll('.chart-hit')[6].click()");
  assert.ok(await evaluate(`document.querySelector('.chart-tooltip').textContent.includes(${JSON.stringify(guangdong.grades["92"].history[6].date)})`));
  await evaluate("document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }))");
  assert.ok(await evaluate("document.querySelector('.chart-tooltip').hidden"));
  await setValue("distance", "9", "input");
  assert.equal(await evaluate("document.getElementById('per-km').textContent"), calculate("9", "9", String(guangdong.grades["92"].price)).perKm.toFixed(2));
  assert.equal(await evaluate("document.getElementById('trip-total').textContent"), expectedTotal(guangdong.grades["92"].price));
  await setValue("grade", "95", "change");
  assert.equal(await evaluate("document.getElementById('current-price').textContent"), guangdong.grades["95"].price.toFixed(2));
  assert.ok(await evaluate("document.querySelector('.chart-latest-line').getAttribute('y1') === [...document.querySelectorAll('.chart-point')].at(-1).getAttribute('cy')"), "latest price line must follow the selected grade");
  assert.equal(await evaluate("document.getElementById('trip-total').textContent"), expectedTotal(guangdong.grades["95"].price));
  await evaluate("document.querySelectorAll('.chart-hit')[0].focus()");
  assert.ok(await evaluate(`document.querySelector('.chart-tooltip').textContent.includes(${JSON.stringify(guangdong.grades["95"].history[0].price.toFixed(2))})`));
  await setValue("grade", "98", "change");
  assert.equal(await evaluate("document.getElementById('current-price').textContent"), "—");
  assert.equal(await evaluate("document.getElementById('trip-total').textContent"), "—");
  await setValue("trip-price", "10", "input");
  assert.equal(await evaluate("document.getElementById('trip-total').textContent"), "8.10");
  assert.ok(await evaluate("document.getElementById('chart-wrap').textContent.includes('暂无')"));
  assert.equal(await evaluate("document.querySelectorAll('.chart-hit').length"), 0);
  assert.equal(await evaluate("document.querySelectorAll('.chart-latest-line').length"), 0);
  assert.equal(await evaluate("document.getElementById('prediction').textContent"), "暂无可靠预估");
  assert.ok(await evaluate("document.getElementById('sync-note').textContent.includes('本地模式')"));
  await evaluate("document.getElementById('open-support').focus(); document.getElementById('open-support').click()");
  assert.ok(await evaluate("document.getElementById('support-dialog').open"));
  assert.equal(await evaluate("document.querySelector('.support-description').firstChild.textContent"), "BesFuel 所有功能完全开源、免费，且没有任何广告，完全由作者用爱发电。如果你喜欢 BesFuel，欢迎自愿打赏，非常感谢！");
  assert.deepEqual(await evaluate("(() => { const link = document.querySelector('.support-source-link'); return [link.href, link.target, link.rel, link.textContent]; })()"), ["https://github.com/BensonLaur/BesFuel", "_blank", "noopener noreferrer", "查看 GitHub 源代码 ↗"]);
  await waitForSupportImage();
  assert.ok(await evaluate("document.getElementById('support-image').naturalWidth > 0"));
  await evaluate("document.querySelector('[data-method=alipay]').click()");
  assert.ok(await evaluate("document.getElementById('support-image').src.endsWith('/resources/support/alipay.png')"));
  assert.equal(await evaluate("document.querySelector('[data-method=alipay]').getAttribute('aria-pressed')"), "true");
  assert.ok(await evaluate("document.getElementById('support-save-image').hasAttribute('download')"));
  await evaluate("document.getElementById('close-support').click()");
  assert.equal(await evaluate("document.getElementById('support-dialog').open"), false);
  assert.equal(await evaluate("document.activeElement.id"), "open-support");
  assert.equal(await evaluate("document.getElementById('trip-total').textContent"), "8.10");
  await send("Emulation.setDeviceMetricsOverride", { width: 320, height: 800, deviceScaleFactor: 1, mobile: true });
  assert.ok(await evaluate("document.documentElement.scrollWidth <= 320"), "320px mobile viewport must not scroll horizontally");
  await setValue("grade", "92", "change");
  await evaluate("document.querySelectorAll('.chart-hit')[0].click()");
  assert.ok(await evaluate("(() => { const box = document.querySelector('.chart-tooltip').getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; })()"), "history tooltip must fit 320px viewport");
  await evaluate("document.getElementById('open-support').click()");
  assert.ok(await evaluate("document.getElementById('support-dialog').getBoundingClientRect().right <= 320"), "support dialog must fit 320px viewport");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  assert.equal(await evaluate("document.getElementById('support-dialog').open"), false);
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  assert.ok(await evaluate("document.documentElement.scrollWidth <= 1280"), "desktop viewport must not scroll horizontally");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 1500, deviceScaleFactor: 1, mobile: true });
  assert.deepEqual(errors, []);
  if (process.env.BESFUEL_SCREENSHOT) {
    await setValue("grade", "92", "change");
    const target = path.parse(process.env.BESFUEL_SCREENSHOT);
    const screenshot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    fs.writeFileSync(process.env.BESFUEL_SCREENSHOT, Buffer.from(screenshot.data, "base64"));
    await evaluate("document.querySelectorAll('.chart-hit')[6].dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }))");
    const historyScreenshot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    fs.writeFileSync(path.join(target.dir, `${target.name}-history${target.ext}`), Buffer.from(historyScreenshot.data, "base64"));
    await evaluate("document.querySelectorAll('.chart-hit')[6].dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }))");
    await evaluate("document.getElementById('open-support').click()");
    const supportScreenshot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    fs.writeFileSync(path.join(target.dir, `${target.name}-support${target.ext}`), Buffer.from(supportScreenshot.data, "base64"));
    await evaluate("document.getElementById('close-support').click()");
  }
  await evaluate(`(() => {
    const region = structuredClone(window.BESFUEL_DATA.regions.guangdong);
    region.name = '示例地区';
    region.grades['92'].price = 7.77;
    window.BESFUEL_DATA.regions.example = region;
    const select = document.getElementById('region');
    select.add(new Option(region.name, 'example'));
    select.value = 'example'; select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  assert.equal(await evaluate("document.getElementById('region-label').textContent"), "示例地区");
  await setValue("grade", "92", "change");
  assert.equal(await evaluate("document.getElementById('current-price').textContent"), "7.77");
  assert.equal(await evaluate("document.getElementById('region').selectedOptions[0].textContent"), "示例地区");
  assert.equal(await evaluate("document.getElementById('trip-total').textContent"), expectedTotal(7.77));
  server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const allowed = new Map([["/", "index.html"], ["/index.html", "index.html"], ["/styles.css", "styles.css"],
      ["/app.js", "app.js"], ["/data/prices.js", "data/prices.js"], ["/lib/calc.js", "lib/calc.js"]]);
    if (pathname === "/data/prices.json") {
      const snapshot = JSON.parse(fs.readFileSync(path.join(root, "data", "prices.json"), "utf8"));
      snapshot.regions.guangdong.grades["92"].price = Number((guangdong.grades["92"].price + .07).toFixed(2));
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      setTimeout(() => response.end(JSON.stringify(snapshot)), 700);
      return;
    }
    if (!allowed.has(pathname)) { response.writeHead(404).end(); return; }
    const file = allowed.get(pathname);
    response.setHeader("Content-Type", file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "application/javascript" : "text/html");
    response.end(fs.readFileSync(path.join(root, file)));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await evaluate("document.getElementById('current-price')?.textContent") === guangdong.grades["92"].price.toFixed(2)) break;
    await delay(50);
  }
  assert.equal(await evaluate("document.getElementById('current-price').textContent"), guangdong.grades["92"].price.toFixed(2));
  await setValue("distance", "9", "input");
  await setValue("trip-price", "10", "input");
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await evaluate("document.getElementById('current-price').textContent") === (guangdong.grades["92"].price + .07).toFixed(2)) break;
    await delay(50);
  }
  assert.equal(await evaluate("document.getElementById('current-price').textContent"), (guangdong.grades["92"].price + .07).toFixed(2));
  assert.equal(await evaluate("document.getElementById('trip-price').value"), "10");
  assert.equal(await evaluate("document.getElementById('trip-total').textContent"), "8.10");
  if (process.env.BESFUEL_DEPLOY_URL) {
    await send("Page.navigate", { url: process.env.BESFUEL_DEPLOY_URL });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate("(() => { const value = document.getElementById('current-price')?.textContent; return value && value !== '—' && Number.isFinite(Number(value)); })()")) break;
      await delay(100);
    }
    assert.equal(await evaluate("document.getElementById('region-label').textContent"), "广东");
    assert.ok(await evaluate("Number.isFinite(Number(document.getElementById('current-price').textContent))"));
    assert.ok(await evaluate("document.querySelectorAll('.chart-hit').length > 0"));
    await evaluate("document.querySelectorAll('.chart-hit')[1].dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }))");
    assert.ok(await evaluate("document.querySelector('.chart-tooltip').textContent.includes('元/升')"));
    await evaluate("document.getElementById('open-support').click()");
    await waitForSupportImage();
    assert.ok(await evaluate("document.getElementById('support-image').naturalWidth > 0"), "published original image must load");
    assert.ok(await evaluate("document.documentElement.scrollWidth <= innerWidth"), "published mobile viewport must fit");
  }
  assert.deepEqual(errors, []);
  console.log("Browser smoke passed: mobile and desktop layout, history hover/touch/keyboard, region and grade linkage, support dialog, missing data, manual price, and background snapshot update.");
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (socket && socket.readyState === WebSocket.OPEN) socket.close();
  if (browser) browser.kill();
  if (server) server.close();
  if (profile) {
    await delay(250);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* Browser may release files shortly after exit. */ }
  }
});
