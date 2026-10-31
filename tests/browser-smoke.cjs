const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { calculate } = require("../lib/calc.js");
const { buildHistory } = require("../lib/history.js");
const { readDevToolsPort } = require("./helpers/browser-port.cjs");
const { createSnapshot } = require("./helpers/snapshot.cjs");

const root = path.resolve(process.env.BESFUEL_SITE_DIR || path.join(__dirname, ".."));
const snapshot = JSON.parse(fs.readFileSync(path.join(root, "data", "prices.json"), "utf8"));
const crudeSnapshot = JSON.parse(fs.readFileSync(path.join(root, "data", "crude-prices.json"), "utf8"));
const crudeModel = require("../lib/crude.js");
const alternateProvider = crudeModel.providers[crudeModel.providerId(crudeSnapshot.series.wti) === "sina" ? "eastmoney" : "sina"];
const guangdong = snapshot.regions.guangdong;
const national = snapshot.nationalAdjustment;
const dateParts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
}).formatToParts(new Date()).map(part => [part.type, part.value]));
const todayIso = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
const forecastAge = (Date.parse(`${todayIso}T00:00:00Z`) - Date.parse(`${national.forecast.updatedAt}T00:00:00Z`)) / 86400000;
const windowFresh = Boolean(national.nextAdjustment.date && national.nextAdjustment.date >= todayIso);
const forecastVisible = Boolean(windowFresh && national.forecast.description &&
  national.forecast.windowDate === national.nextAdjustment.date && forecastAge >= 0);
const forecastFresh = forecastVisible && forecastAge <= 2;
const expectedTotal = price => calculate("9", "9", String(price)).total.toFixed(2);
const edge = process.env.BROWSER_PATH || path.join(process.env["PROGRAMFILES(X86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, socket, profile, server;

async function main() {
  if (!fs.existsSync(edge)) throw new Error("Set BROWSER_PATH to a Chromium-based browser executable.");
  profile = fs.mkdtempSync(path.join(os.tmpdir(), "besfuel-smoke-"));
  const browserArgs = ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-extensions", "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`];
  if (process.env.BESFUEL_BROWSER_PROXY) browserArgs.push(`--proxy-server=${process.env.BESFUEL_BROWSER_PROXY}`);
  browser = spawn(edge, [...browserArgs, "about:blank"], { stdio: "ignore", windowsHide: true });
  let launchError;
  browser.on("error", error => { launchError = error; });
  let port;
  const activePort = path.join(profile, "DevToolsActivePort");
  for (let attempt = 0; attempt < 100; attempt++) {
    if (launchError) throw launchError;
    port = readDevToolsPort(activePort);
    if (port !== null) break;
    await delay(100);
  }
  if (!port) throw new Error("Browser debugging endpoint did not become ready within 10 seconds (DevToolsActivePort).");
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
  assert.equal(await evaluate("document.getElementById('next-window').textContent"), windowFresh ? national.nextAdjustment.dateLabel : national.nextAdjustment.date ? "待重新核实" : "待核实");
  assert.equal(await evaluate("document.getElementById('prediction-text').textContent"), forecastVisible ? national.forecast.description : "暂无本轮可靠预估");
  assert.equal(await evaluate("document.getElementById('prediction-arrow').hidden"), !forecastFresh);
  if (forecastFresh) assert.equal(await evaluate("document.getElementById('prediction-arrow').textContent"), national.forecast.direction === "up" ? "↑" : "↓");
  assert.equal(await evaluate("document.getElementById('prediction-source').hidden"), !forecastVisible);
  if (forecastVisible) assert.equal(await evaluate("document.getElementById('prediction-source').href"), national.forecast.sourceUrl);
  assert.equal(await evaluate("document.getElementById('prediction-status').hidden"), !forecastVisible || forecastFresh);
  assert.equal(await evaluate("document.getElementById('window-rule-source').hidden"), !windowFresh);
  assert.equal(await evaluate("document.getElementById('region-label').textContent"), "广东");
  assert.equal(await evaluate("document.getElementById('region').selectedOptions[0].textContent"), "广东");
  assert.equal(await evaluate("document.getElementById('latest-notice').hidden"), !guangdong.latestNotice);
  if (guangdong.latestNotice) {
    assert.equal(await evaluate("document.getElementById('latest-notice-source').href"), guangdong.latestNotice.sourceUrl);
    assert.ok(await evaluate(`document.getElementById('latest-notice-source').textContent.includes(${JSON.stringify(guangdong.latestNotice.date)})`));
  }
  await evaluate("document.getElementById('open-crude').focus(); document.getElementById('open-crude').click()");
  assert.equal(await evaluate("document.getElementById('crude-dialog').open"), true);
  const crudeQuote = crudeSnapshot.series.wti.intraday || crudeSnapshot.series.wti.history.at(-1);
  assert.equal(await evaluate("document.getElementById('crude-price').textContent"), crudeQuote.price.toFixed(2));
  assert.ok(await evaluate(`document.getElementById('crude-asof').textContent.includes(${JSON.stringify(crudeQuote.date)})`));
  assert.equal(await evaluate("document.querySelectorAll('#crude-dialog iframe').length"), 0);
  assert.equal(await evaluate("document.querySelector('.crude-endpoint').classList.contains('provisional')"), Boolean(crudeSnapshot.series.wti.intraday));
  const monthCount = await evaluate("document.querySelectorAll('.crude-hit').length");
  await evaluate("document.querySelector('[data-crude-days=\"180\"]').click()");
  assert.ok(await evaluate("document.querySelectorAll('.crude-hit').length") > monthCount);
  await evaluate("document.querySelector('[data-crude-series=\"brent\"]').click()");
  const brentQuote = crudeSnapshot.series.brent.intraday || crudeSnapshot.series.brent.history.at(-1);
  assert.equal(await evaluate("document.getElementById('crude-price').textContent"), brentQuote.price.toFixed(2));
  assert.equal(await evaluate("document.getElementById('crude-source').href"), crudeSnapshot.series.brent.sourceUrl);
  await evaluate("document.querySelector('.crude-hit').focus()");
  assert.ok(await evaluate("!document.querySelector('.crude-tooltip').hidden"));
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "End", code: "End", windowsVirtualKeyCode: 35 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "End", code: "End", windowsVirtualKeyCode: 35 });
  assert.ok(await evaluate(`document.querySelector('.crude-tooltip').textContent.includes(${JSON.stringify(brentQuote.date)})`));
  await evaluate("document.querySelector('.crude-hit').dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }))");
  await send("Emulation.setDeviceMetricsOverride", { width: 391, height: 1500, deviceScaleFactor: 1, mobile: true });
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  assert.equal(await evaluate("document.activeElement.className"), "crude-hit", "chart resize preserves keyboard focus");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "End", code: "End", windowsVirtualKeyCode: 35 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "End", code: "End", windowsVirtualKeyCode: 35 });
  assert.ok(await evaluate(`document.querySelector('.crude-tooltip').textContent.includes(${JSON.stringify(brentQuote.date)})`));
  await evaluate("document.querySelector('[data-crude-days=\"30\"]').click()");
  for (const width of [320, 390, 1280]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
    await delay(80);
    assert.ok(await evaluate("(() => { const d = document.getElementById('crude-dialog'); return d.scrollWidth <= d.clientWidth && document.documentElement.scrollWidth <= innerWidth; })()"), `crude modal must fit ${width}px`);
    await evaluate("document.querySelectorAll('.crude-hit')[0].click()");
    assert.ok(await evaluate("(() => { const tip = document.querySelector('.crude-tooltip').getBoundingClientRect(); const box = document.getElementById('crude-chart').getBoundingClientRect(); return tip.left >= box.left - 1 && tip.right <= box.right + 1; })()"), "crude tooltip fits chart");
    if (process.env.BESFUEL_SCREENSHOT) {
      const target = path.parse(process.env.BESFUEL_SCREENSHOT);
      await evaluate("document.getElementById('close-crude').focus(); document.getElementById('crude-dialog').scrollTop = 0");
      const shot = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(target.dir, `${target.name}-crude-${width}${target.ext}`), Buffer.from(shot.data, "base64"));
    }
  }
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  assert.equal(await evaluate("document.getElementById('crude-dialog').open"), false);
  assert.equal(await evaluate("document.activeElement.id"), "open-crude");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 1500, deviceScaleFactor: 1, mobile: true });
  const initialHistory = buildHistory(guangdong, "92", todayIso);
  assert.equal(await evaluate("document.querySelectorAll('.chart-point').length"), initialHistory.points.length);
  assert.equal(await evaluate("document.querySelectorAll('.chart-hit').length"), initialHistory.points.length);
  assert.ok(await evaluate(`document.getElementById('history-range').textContent.endsWith(${JSON.stringify(initialHistory.points.at(-1).date)})`));
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
  for (const [key, region] of Object.entries(snapshot.regions)) {
    if (key === "guangdong") continue;
    await setValue("region", key, "change");
    assert.equal(await evaluate("document.getElementById('region-label').textContent"), region.name);
    const available = region.grades["92"].price !== null && (!region.priceValidThrough || region.priceValidThrough >= todayIso);
    assert.equal(await evaluate("document.getElementById('current-price').textContent"), available ? region.grades["92"].price.toFixed(2) : "—");
    assert.equal(await evaluate("document.querySelectorAll('.chart-point').length"), buildHistory(region, "92", todayIso).points.length);
    assert.equal(await evaluate("document.getElementById('next-window').textContent"), windowFresh ? national.nextAdjustment.dateLabel : national.nextAdjustment.date ? "待重新核实" : "待核实");
  }
  await setValue("region", "guangdong", "change");
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
  assert.equal(await evaluate("document.getElementById('prediction-text').textContent"), forecastVisible ? national.forecast.description : "暂无本轮可靠预估");
  assert.ok(await evaluate("document.getElementById('sync-note').textContent.includes('本地模式')"));
  await evaluate("document.getElementById('open-support').focus(); document.getElementById('open-support').click()");
  assert.ok(await evaluate("document.getElementById('support-dialog').open"));
  assert.equal(await evaluate("document.querySelector('.support-description').textContent"), "BesFuel 所有功能完全开源（查看 GitHub 源代码 ↗）、免费，且没有任何广告，完全由作者用爱发电。如果你喜欢 BesFuel，欢迎自愿打赏，支持它继续完善。非常感谢！");
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
  // Real snapshot checks above stay separate from deterministic UI scenarios.
  const noticeSnapshot = createSnapshot("hebei", "shaanxi-xian", "heilongjiang-south");
  const noticeGuangdong = noticeSnapshot.regions.guangdong;
  async function installScenario(data, day) {
    await evaluate(`(() => {
      window.fixtureOriginalDate ||= Date;
      window.fixtureDay = ${JSON.stringify(day)};
      window.Date = class extends window.fixtureOriginalDate {
        constructor(...args) { super(...(args.length ? args : [window.fixtureDay + 'T12:00:00+08:00'])); }
        static now() { return new window.fixtureOriginalDate(window.fixtureDay + 'T12:00:00+08:00').getTime(); }
      };
      Object.assign(window.BESFUEL_DATA, ${JSON.stringify(data)});
      document.getElementById('region').value = 'guangdong';
      document.getElementById('grade').value = '92';
      document.getElementById('region').dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  }
  await installScenario(noticeSnapshot, '2026-10-22');
  if (noticeSnapshot.regions["shaanxi-xian"]) {
    await setValue("region", "shaanxi-xian", "change");
    assert.equal(await evaluate("(document.querySelector('.chart-path').getAttribute('d').match(/\\bM\\b/g) || []).length"), 3);
    assert.ok(await evaluate("document.getElementById('history-note').textContent.includes('2026-05-22')"));
    assert.ok(await evaluate("document.getElementById('history-note').textContent.includes('2026-08-15')"));
  }
  if (noticeSnapshot.regions["heilongjiang-south"]) {
    await setValue("region", "heilongjiang-south", "change");
    await evaluate("window.BESFUEL_DATA.regions['heilongjiang-south'].priceValidThrough = '2000-01-01'; document.getElementById('region').dispatchEvent(new Event('change', { bubbles: true }))");
    assert.equal(await evaluate("document.getElementById('current-price').textContent"), "—");
    assert.equal(await evaluate("document.getElementById('freshness').textContent"), "待复核");
    assert.equal(await evaluate("document.getElementById('trip-price').value"), "");
    assert.ok(await evaluate("document.getElementById('price-detail').textContent.includes('季节折算系数已到期')"));
  }
  // An unchanged decision is separate from price history, future estimates and the selected grade.
  await setValue("region", "guangdong", "change");
  await setValue("grade", "92", "change");
  await evaluate(`(() => {
    const region = window.BESFUEL_DATA.regions.guangdong;
    window.savedLatestNotice = region.latestNotice;
    region.latestNotice = {
      date: '2026-10-15', kind: 'unchanged', title: '2026年10月15日成品油价格不作调整',
      sourceUrl: 'https://drc.gd.gov.cn/ywgg/content/post_4967003.html'
    };
    document.getElementById('region').dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  assert.equal(await evaluate("document.getElementById('latest-notice-source').textContent"), "2026-10-15 · 本轮不作调整，继续执行当前价格 ↗");
  assert.equal(await evaluate("document.getElementById('effective-time').textContent"), noticeGuangdong.effectiveLabel);
  assert.equal(await evaluate("document.getElementById('current-price').textContent"), noticeGuangdong.grades["92"].price.toFixed(2));
  assert.equal(await evaluate("document.querySelectorAll('.chart-point').length"), noticeGuangdong.grades["92"].history.length + 1);
  assert.ok(await evaluate("document.getElementById('history-range').textContent.endsWith('2026-10-15')"));
  assert.equal(await evaluate("document.getElementById('history-count').textContent"), `${noticeGuangdong.grades["92"].history.length} 条价格记录 · 1 条不调整公告`);
  assert.ok(await evaluate("document.querySelector('.chart-value').textContent.includes('不调整')"));
  assert.ok(await evaluate("document.getElementById('history-note').textContent.includes('空心节点')"));
  await evaluate("[...document.querySelectorAll('.chart-hit')].at(-1).click()");
  assert.equal(await evaluate("document.querySelector('.chart-tooltip').textContent"), `2026-10-15 不作调整${noticeGuangdong.grades["92"].price.toFixed(2)} 元/升`);
  assert.ok(await evaluate("[...document.querySelectorAll('.chart-hit')].at(-1).getAttribute('aria-label').includes('不作调整')"));
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 });
  assert.ok(await evaluate("document.querySelector('.chart-tooltip').textContent.includes('生效')"));
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
  assert.ok(await evaluate("document.querySelector('.chart-tooltip').textContent.includes('不作调整')"));
  for (const width of [320, 750, 1280]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 });
    assert.ok(await evaluate("document.documentElement.scrollWidth <= innerWidth"), `latest notice must fit ${width}px viewport`);
    await evaluate("[...document.querySelectorAll('.chart-hit')].at(-1).click()");
    assert.ok(await evaluate("(() => { const chart = document.getElementById('chart-wrap').getBoundingClientRect(); const tip = document.querySelector('.chart-tooltip').getBoundingClientRect(); return tip.left >= chart.left && tip.right <= chart.right; })()"), `unchanged tooltip must fit ${width}px chart`);
    if (process.env.BESFUEL_SCREENSHOT) {
      const target = path.parse(process.env.BESFUEL_SCREENSHOT);
      const clip = await evaluate("(() => { const box = document.querySelector('.price-card').getBoundingClientRect(); return { x: box.left + scrollX, y: box.top + scrollY, width: box.width, height: box.height, scale: 1 }; })()");
      const screenshot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip });
      fs.writeFileSync(path.join(target.dir, `${target.name}-notice-${width}${target.ext}`), Buffer.from(screenshot.data, "base64"));
      const chartClip = await evaluate("(() => { const box = document.querySelector('.history-card').getBoundingClientRect(); return { x: box.left + scrollX, y: box.top + scrollY, width: box.width, height: box.height, scale: 1 }; })()");
      const chartScreenshot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: chartClip });
      fs.writeFileSync(path.join(target.dir, `${target.name}-chart-${width}${target.ext}`), Buffer.from(chartScreenshot.data, "base64"));
    }
  }
  await evaluate("window.BESFUEL_DATA.regions.guangdong.priceValidThrough = '2000-01-01'; document.getElementById('region').dispatchEvent(new Event('change', { bubbles: true }))");
  assert.equal(await evaluate("document.getElementById('current-price').textContent"), "—");
  assert.ok(await evaluate("document.getElementById('latest-notice-source').textContent.includes('折算系数仍待复核')"));
  await evaluate("delete window.BESFUEL_DATA.regions.guangdong.priceValidThrough");
  await setValue("grade", "98", "change");
  assert.ok(await evaluate("document.getElementById('latest-notice-source').textContent.includes('该油号暂无已核实报价')"));
  assert.ok(await evaluate("!document.getElementById('latest-notice-source').textContent.includes('继续执行当前价格')"));
  await setValue("grade", "92", "change");
  await setValue("region", "hebei", "change");
  assert.equal(await evaluate("document.getElementById('latest-notice').hidden"), true);
  assert.equal(await evaluate("document.getElementById('latest-notice-source').hasAttribute('href')"), false);
  await setValue("region", "guangdong", "change");
  assert.equal(await evaluate("document.getElementById('latest-notice').hidden"), false);
  await evaluate("window.BESFUEL_DATA.regions.guangdong.latestNotice.kind = 'adjusted'; document.getElementById('region').dispatchEvent(new Event('change', { bubbles: true }))");
  assert.ok(await evaluate("document.getElementById('latest-notice-source').textContent.includes('本轮价格调整')"));
  assert.equal(await evaluate("document.querySelectorAll('.chart-point').length"), noticeGuangdong.grades["92"].history.length);
  assert.ok(await evaluate(`document.getElementById('history-range').textContent.endsWith(${JSON.stringify(noticeGuangdong.grades["92"].history.at(-1).date)})`));
  await evaluate("delete window.BESFUEL_DATA.regions.guangdong.latestNotice; document.getElementById('region').dispatchEvent(new Event('change', { bubbles: true }))");
  assert.equal(await evaluate("document.getElementById('latest-notice').hidden"), true);
  await evaluate("if (window.savedLatestNotice) window.BESFUEL_DATA.regions.guangdong.latestNotice = window.savedLatestNotice");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 1500, deviceScaleFactor: 1, mobile: true });
  // A newer price can cross a month or year; older unchanged notices must
  // disappear while a subsequent unchanged decision adds exactly one node.
  for (const [effective, noticeDay] of [['2026-10-30', '2026-11-12'], ['2026-11-13', '2026-11-26'], ['2027-01-01', '2027-01-14']]) {
    const data = structuredClone(noticeSnapshot), region = data.regions.guangdong;
    data.checkedAt = region.checkedAt = noticeDay;
    for (const grade of ['92', '95', 'diesel']) {
      const entry = region.grades[grade];
      entry.price = Number((entry.price + .1).toFixed(2));
      entry.history.push({ date: effective, price: entry.price, sourceUrl: region.source.url });
    }
    region.latestNotice = { kind: 'unchanged', date: '2026-10-15', title: '旧周期不调整公告', sourceUrl: region.source.url };
    await installScenario(data, noticeDay);
    assert.equal(await evaluate("document.querySelectorAll('.chart-point').length"), 3, 'old notice cannot extend a new price history');
    region.latestNotice.date = noticeDay;
    await installScenario(data, noticeDay);
    assert.equal(await evaluate("document.querySelectorAll('.chart-point').length"), 4);
    assert.equal(await evaluate("document.getElementById('current-price').textContent"), '8.73');
    assert.ok(await evaluate(`document.getElementById('history-range').textContent.endsWith(${JSON.stringify(noticeDay)})`));
  }
  await installScenario(noticeSnapshot, '2026-10-22');
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 1500, deviceScaleFactor: 1, mobile: true });
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
  assert.equal(await evaluate("document.getElementById('prediction-text').textContent"), "暂无本轮可靠预估");
  await evaluate(`(() => {
    const OriginalDate = Date;
    window.forecastTestDay = '2026-10-02';
    window.Date = class extends OriginalDate {
      constructor(...args) { super(...(args.length ? args : [window.forecastTestDay + 'T12:00:00+08:00'])); }
      static now() { return new OriginalDate(window.forecastTestDay + 'T12:00:00+08:00').getTime(); }
    };
    const national = window.BESFUEL_DATA.nationalAdjustment;
    national.nextAdjustment.date = '2026-10-15';
    national.nextAdjustment.dateLabel = '预计 2026-10-15 24:00';
    national.forecast = {
      windowDate: '2026-10-15', updatedAt: '2026-09-30', workday: 3,
      direction: 'down', amountPerLiter: 0.19, description: '预计下调约 0.19 元/升',
      sourceName: '团友网', sourceUrl: 'https://www.tuanyou.net/yuanyou/bianhualv/816.html'
    };
    document.getElementById('region').dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  assert.equal(await evaluate("document.getElementById('prediction-arrow').textContent"), "↓");
  assert.equal(await evaluate("document.getElementById('prediction-arrow').hidden"), false);
  assert.equal(await evaluate("document.getElementById('prediction-status').hidden"), true);
  assert.equal(await evaluate("document.getElementById('prediction-label').textContent"), "市场估算 · 全国参考");
  for (const day of ['2026-10-03', '2026-10-06', '2026-10-15']) {
    await evaluate(`window.forecastTestDay = ${JSON.stringify(day)}; document.getElementById('region').dispatchEvent(new Event('change', { bubbles: true }))`);
    assert.equal(await evaluate("document.getElementById('prediction-text').textContent"), "预计下调约 0.19 元/升");
    assert.equal(await evaluate("document.getElementById('prediction-label').textContent"), "本轮最近估算 · 全国参考");
    assert.equal(await evaluate("document.getElementById('prediction-detail').textContent"), "团友网 · 2026-09-30 计算 · 第 3 个工作日");
    assert.equal(await evaluate("document.getElementById('prediction-status').hidden"), false);
    assert.equal(await evaluate("document.getElementById('prediction-status').textContent"), "已超过两天，等待本轮更新；仅作历史参考");
    assert.ok(await evaluate("document.getElementById('prediction').classList.contains('stale') && document.getElementById('prediction-arrow').hidden"));
    assert.equal(await evaluate("document.getElementById('prediction-source').hidden"), false);
    assert.equal(await evaluate("document.getElementById('prediction-source').href"), "https://www.tuanyou.net/yuanyou/bianhualv/816.html");
  }
  await evaluate("window.forecastTestDay = '2026-10-06'; document.getElementById('region').dispatchEvent(new Event('change', { bubbles: true }))");
  for (const width of [320, 750, 1280]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 });
    assert.ok(await evaluate("document.documentElement.scrollWidth <= innerWidth"), `stale forecast must fit ${width}px viewport`);
    if (process.env.BESFUEL_SCREENSHOT) {
      const target = path.parse(process.env.BESFUEL_SCREENSHOT);
      const clip = await evaluate("(() => { const box = document.querySelector('.adjustment-card').getBoundingClientRect(); return { x: box.left + scrollX, y: box.top + scrollY, width: box.width, height: box.height, scale: 1 }; })()");
      const screenshot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip });
      fs.writeFileSync(path.join(target.dir, `${target.name}-forecast-${width}${target.ext}`), Buffer.from(screenshot.data, "base64"));
    }
  }
  // An ended window, a changed cycle, missing dates and future estimates cannot act as this cycle's reference.
  for (const mutation of [
    "window.forecastTestDay = '2026-10-16'",
    "window.forecastTestDay = '2026-10-06'; window.BESFUEL_DATA.nationalAdjustment.nextAdjustment.date = '2026-10-29'",
    "window.BESFUEL_DATA.nationalAdjustment.nextAdjustment.date = '2026-10-15'; window.BESFUEL_DATA.nationalAdjustment.forecast.updatedAt = null",
    "window.BESFUEL_DATA.nationalAdjustment.forecast.updatedAt = 'invalid'",
    "window.BESFUEL_DATA.nationalAdjustment.forecast.updatedAt = '2026-10-07'"
  ]) {
    await evaluate(`${mutation}; document.getElementById('region').dispatchEvent(new Event('change', { bubbles: true }))`);
    assert.equal(await evaluate("document.getElementById('prediction-text').textContent"), "暂无本轮可靠预估");
    assert.ok(await evaluate("document.getElementById('prediction-arrow').hidden && document.getElementById('prediction-source').hidden && document.getElementById('prediction-status').hidden"));
    assert.equal(await evaluate("document.getElementById('prediction').classList.contains('stale')"), false);
  }
  await evaluate(`(() => {
    const forecast = window.BESFUEL_DATA.nationalAdjustment.forecast;
    forecast.updatedAt = '2026-10-06';
    forecast.direction = 'up';
    forecast.description = '预计上调约 0.18 元/升';
    document.getElementById('region').dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  assert.equal(await evaluate("document.getElementById('prediction-arrow').textContent"), "↑");
  assert.ok(await evaluate("document.getElementById('prediction-arrow').classList.contains('up')"));
  assert.equal(await evaluate("document.getElementById('prediction-text').textContent"), "预计上调约 0.18 元/升");
  assert.equal(await evaluate("document.getElementById('prediction-arrow').hidden"), false);
  assert.ok(await evaluate("document.getElementById('prediction-status').hidden && !document.getElementById('prediction').classList.contains('stale')"));
  await evaluate("window.BESFUEL_DATA.nationalAdjustment.forecast = {}; document.getElementById('region').dispatchEvent(new Event('change', { bubbles: true }))");
  assert.equal(await evaluate("document.getElementById('prediction-text').textContent"), "暂无本轮可靠预估");
  assert.equal(await evaluate("document.getElementById('prediction-source').hidden"), true);
  assert.equal(await evaluate("document.getElementById('trip-total').textContent"), expectedTotal(7.77));
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 1500, deviceScaleFactor: 1, mobile: true });
  let crudeResponseMode = "valid";
  server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const allowed = new Map([["/", "index.html"], ["/index.html", "index.html"], ["/styles.css", "styles.css"],
      ["/app.js", "app.js"], ["/data/prices.js", "data/prices.js"], ["/lib/calc.js", "lib/calc.js"], ["/lib/history.js", "lib/history.js"],
      ["/crude-ui.js", "crude-ui.js"], ["/lib/crude.js", "lib/crude.js"], ["/data/crude-prices.js", "data/crude-prices.js"]]);
    if (pathname === "/data/crude-prices.json") {
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      const fresh = structuredClone(crudeSnapshot);
      delete fresh.collection;
      if (crudeResponseMode === "alternate" || crudeResponseMode === "alternate-partly-older") {
        fresh.updatedAt = new Date(Math.max(Date.parse(fresh.updatedAt), Date.parse(crudeSnapshot.collection?.checkedAt || fresh.updatedAt)) + 1000).toISOString();
        for (const [id, series] of Object.entries(fresh.series)) {
          const provider = alternateProvider;
          Object.assign(series, provider.instruments[id], { sourceName: provider.name, basis: provider.basis, fetchedAt: fresh.updatedAt });
          series.history = series.history.slice(-12);
          (series.intraday || series.history.at(-1)).price += .11;
        }
        if (crudeResponseMode === "alternate-partly-older") {
          fresh.series.brent.fetchedAt = new Date(Date.parse(crudeSnapshot.series.brent.fetchedAt) - 60000).toISOString();
        }
      }
      if (crudeResponseMode === "invalid") delete fresh.series.wti;
      if (crudeResponseMode === "older") {
        fresh.updatedAt = new Date(Date.parse(fresh.updatedAt) - 60000).toISOString();
        for (const series of Object.values(fresh.series)) series.fetchedAt = new Date(Date.parse(series.fetchedAt) - 60000).toISOString();
        (fresh.series.wti.intraday || fresh.series.wti.history.at(-1)).price += 10;
      }
      if (["auto-yahoo", "auto-yahoo-old-status", "auto-outage", "auto-recovered"].includes(crudeResponseMode)) {
        const recovered = crudeResponseMode === "auto-recovered";
        const providerId = recovered ? "eastmoney" : "yahoo";
        const provider = crudeModel.providers[providerId];
        const baseTime = Math.max(Date.parse(crudeSnapshot.updatedAt), Date.parse(crudeSnapshot.collection?.checkedAt || crudeSnapshot.updatedAt));
        fresh.updatedAt = new Date(baseTime + (recovered ? 4000 : 2000)).toISOString();
        for (const [id, series] of Object.entries(fresh.series)) {
          Object.assign(series, provider.instruments[id], { sourceName: provider.name, basis: provider.basis, fetchedAt: fresh.updatedAt });
          series.history = series.history.slice(-12);
          (series.intraday || series.history.at(-1)).price += recovered ? .33 : .22;
        }
        const outage = crudeResponseMode === "auto-outage" || crudeResponseMode === "auto-yahoo-old-status";
        fresh.collection = {
          mode: "auto", activeProvider: providerId, outcome: outage ? "retained" : "updated",
          checkedAt: new Date(baseTime + (recovered ? 4000 : outage ? 3000 : 2000)).toISOString(),
          switchedFrom: outage ? null : recovered ? "yahoo" : (alternateProvider === crudeModel.providers.yahoo ? "eastmoney" : Object.keys(crudeModel.providers).find(id => crudeModel.providers[id] === alternateProvider)),
          attempts: recovered ? [{ provider: "eastmoney", ok: true, reason: "" }] : outage
            ? crudeModel.providerPriority.map(provider => ({ provider, ok: false, reason: "test outage" }))
            : [{ provider: "eastmoney", ok: false, reason: "test outage" }, { provider: "yahoo", ok: true, reason: "" }]
        };
        if (crudeResponseMode === "auto-yahoo-old-status") {
          fresh.collection.checkedAt = new Date(baseTime + 1000).toISOString();
          fresh.updatedAt = fresh.collection.checkedAt;
          for (const series of Object.values(fresh.series)) series.fetchedAt = fresh.updatedAt;
        }
      }
      response.end(JSON.stringify(fresh)); return;
    }
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
  await evaluate("document.getElementById('open-crude').click()");
  await delay(150);
  assert.equal(await evaluate("document.getElementById('crude-price').textContent"), crudeQuote.price.toFixed(2));
  await evaluate("document.getElementById('close-crude').click()");
  crudeResponseMode = "invalid";
  await evaluate("document.getElementById('open-crude').click()");
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await evaluate("document.getElementById('crude-status').textContent.includes('继续显示')")) break;
    await delay(50);
  }
  assert.ok(await evaluate("document.getElementById('crude-status').textContent.includes('继续显示')"));
  assert.equal(await evaluate("document.getElementById('crude-price').textContent"), crudeQuote.price.toFixed(2));
  assert.equal(await evaluate("document.getElementById('trip-total').textContent"), "8.10");
  await evaluate("document.getElementById('close-crude').click()");
  crudeResponseMode = "older";
  await evaluate("document.getElementById('open-crude').click()");
  await delay(150);
  assert.equal(await evaluate("document.getElementById('crude-price').textContent"), crudeQuote.price.toFixed(2), "older crude JSON must not replace loaded data");
  await evaluate("document.getElementById('close-crude').click()");
  crudeResponseMode = "alternate-partly-older";
  await evaluate("document.getElementById('open-crude').click()");
  await delay(150);
  assert.equal(await evaluate("document.getElementById('crude-price').textContent"), crudeQuote.price.toFixed(2), "source change cannot replace only one curve");
  assert.equal(await evaluate("document.getElementById('crude-source').textContent"), `${crudeModel.providers[crudeModel.providerId(crudeSnapshot.series.wti)].displayName} ↗`);
  await evaluate("document.getElementById('close-crude').click()");
  crudeResponseMode = "alternate";
  await evaluate("document.getElementById('open-crude').click()");
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await evaluate("document.getElementById('crude-source').textContent") === `${alternateProvider.displayName} ↗`) break;
    await delay(50);
  }
  assert.equal(await evaluate("document.getElementById('crude-source').textContent"), `${alternateProvider.displayName} ↗`);
  assert.equal(await evaluate("document.getElementById('crude-basis').textContent"), alternateProvider.basis === "cfd-daily"
    ? "CFD 差价合约日线 · 第三方参考" : alternateProvider.basis === "nymex-futures-daily"
      ? "NYMEX 期货日线 · 第三方参考" : "期货连续日线 · 第三方参考");
  assert.equal(await evaluate("document.getElementById('crude-price').textContent"), (crudeQuote.price + .11).toFixed(2));
  assert.ok(await evaluate("document.querySelectorAll('.crude-hit').length <= 13"), "source change replaces whole history rather than splicing curves");
  await evaluate("document.querySelector('[data-crude-series=\"brent\"]').click()");
  assert.equal(await evaluate("document.getElementById('crude-source').href"), alternateProvider.instruments.brent.sourceUrl);
  assert.equal(await evaluate("document.getElementById('crude-price').textContent"), (brentQuote.price + .11).toFixed(2));
  for (const width of [320, 1280]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
    assert.ok(await evaluate("(() => { const d = document.getElementById('crude-dialog'); return d.scrollWidth <= d.clientWidth && document.documentElement.scrollWidth <= innerWidth; })()"), `backup source display must fit ${width}px`);
    if (process.env.BESFUEL_SCREENSHOT) {
      const target = path.parse(process.env.BESFUEL_SCREENSHOT);
      await evaluate("document.getElementById('close-crude').focus(); document.getElementById('crude-dialog').scrollTop = 0");
      const shot = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(target.dir, `${target.name}-backup-${width}${target.ext}`), Buffer.from(shot.data, "base64"));
    }
  }
  await evaluate("document.getElementById('close-crude').click()");
  crudeResponseMode = "auto-yahoo";
  await evaluate("document.querySelector('[data-crude-series=\"wti\"]').click(); document.getElementById('open-crude').click(); document.getElementById('close-crude').click(); document.getElementById('open-crude').click()");
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await evaluate("document.getElementById('crude-source').textContent") === "Yahoo Finance ↗") break;
    await delay(50);
  }
  assert.equal(await evaluate("document.getElementById('crude-source').textContent"), "Yahoo Finance ↗");
  assert.equal(await evaluate("document.getElementById('crude-source').href"), crudeModel.providers.yahoo.instruments.wti.sourceUrl);
  assert.equal(await evaluate("document.getElementById('crude-basis').textContent"), "NYMEX 期货日线 · 第三方参考");
  assert.ok(await evaluate("document.getElementById('crude-status').textContent.includes('切换为 Yahoo Finance')"));
  assert.equal(await evaluate("document.getElementById('crude-price').textContent"), (crudeQuote.price + .22).toFixed(2));
  const yahooCollectionTime = await evaluate("document.getElementById('crude-collected').textContent");
  for (const width of [320, 1280]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 });
    assert.ok(await evaluate("(() => { const d = document.getElementById('crude-dialog'); return d.scrollWidth <= d.clientWidth && document.documentElement.scrollWidth <= innerWidth; })()"), `automatic source message fits ${width}px`);
    if (process.env.BESFUEL_SCREENSHOT) {
      const target = path.parse(process.env.BESFUEL_SCREENSHOT);
      await evaluate("document.getElementById('close-crude').focus(); document.getElementById('crude-dialog').scrollTop = 0");
      const shot = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(target.dir, `${target.name}-auto-yahoo-${width}${target.ext}`), Buffer.from(shot.data, "base64"));
    }
  }
  await evaluate("document.getElementById('close-crude').click()");
  crudeResponseMode = "auto-yahoo-old-status";
  await evaluate("document.getElementById('open-crude').click()");
  await delay(200);
  assert.ok(await evaluate("!document.getElementById('crude-status').textContent.includes('更新未成功')"), "older check status must not replace the latest result");
  await evaluate("document.getElementById('close-crude').click()");
  crudeResponseMode = "auto-outage";
  await evaluate("document.getElementById('open-crude').click()");
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await evaluate("document.getElementById('crude-status').textContent.includes('更新未成功')")) break;
    await delay(50);
  }
  assert.ok(await evaluate("document.getElementById('crude-status').textContent.includes('更新未成功')"));
  assert.equal(await evaluate("document.getElementById('crude-collected').textContent"), yahooCollectionTime);
  assert.equal(await evaluate("document.getElementById('crude-price').textContent"), (crudeQuote.price + .22).toFixed(2));
  await evaluate("document.getElementById('close-crude').click()");
  crudeResponseMode = "auto-recovered";
  await evaluate("document.getElementById('open-crude').click()");
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await evaluate("document.getElementById('crude-source').textContent") === "Eastmoney ↗") break;
    await delay(50);
  }
  assert.equal(await evaluate("document.getElementById('crude-source').textContent"), "Eastmoney ↗");
  assert.ok(await evaluate("document.getElementById('crude-status').textContent.includes('切换为 Eastmoney')"));
  assert.ok(await evaluate("!document.getElementById('crude-status').textContent.includes('更新未成功')"));
  assert.equal(await evaluate("document.getElementById('crude-price').textContent"), (crudeQuote.price + .33).toFixed(2));
  assert.equal(await evaluate("document.getElementById('trip-total').textContent"), "8.10");
  await evaluate("document.getElementById('close-crude').click()");
  if (process.env.BESFUEL_DEPLOY_URL) {
    await send("Page.navigate", { url: process.env.BESFUEL_DEPLOY_URL });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate("(() => { const value = document.getElementById('current-price')?.textContent; return value && value !== '—' && Number.isFinite(Number(value)); })()")) break;
      await delay(100);
    }
    assert.equal(await evaluate("document.getElementById('region-label').textContent"), "广东");
    assert.ok(await evaluate("Number.isFinite(Number(document.getElementById('current-price').textContent))"));
    assert.ok(await evaluate("document.querySelectorAll('.chart-hit').length > 0"));
    const liveRegion = await evaluate("window.BESFUEL_DATA.regions.guangdong");
    const liveHistory = buildHistory(liveRegion, "92", todayIso);
    assert.ok(await evaluate(`document.getElementById('history-range').textContent.endsWith(${JSON.stringify(liveHistory.points.at(-1).date)})`));
    assert.equal(await evaluate("document.querySelectorAll('.chart-point').length"), liveHistory.points.length);
    if (liveHistory.noticeCount) {
      await evaluate("[...document.querySelectorAll('.chart-hit')].at(-1).click()");
      assert.ok(await evaluate("document.querySelector('.chart-tooltip').textContent.includes('不作调整')"));
      if (process.env.BESFUEL_SCREENSHOT) {
        const target = path.parse(process.env.BESFUEL_SCREENSHOT);
        const clip = await evaluate("(() => { const box = document.querySelector('.history-card').getBoundingClientRect(); return { x: box.left + scrollX, y: box.top + scrollY, width: box.width, height: box.height, scale: 1 }; })()");
        const screenshot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip });
        fs.writeFileSync(path.join(target.dir, `${target.name}-live-chart${target.ext}`), Buffer.from(screenshot.data, "base64"));
      }
    }
    await evaluate("document.querySelectorAll('.chart-hit')[1].dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }))");
    assert.ok(await evaluate("document.querySelector('.chart-tooltip').textContent.includes('元/升')"));
    await evaluate("document.getElementById('open-support').click()");
    await waitForSupportImage();
    assert.ok(await evaluate("document.getElementById('support-image').naturalWidth > 0"), "published original image must load");
    assert.ok(await evaluate("document.documentElement.scrollWidth <= innerWidth"), "published mobile viewport must fit");
    await evaluate("document.getElementById('close-support').click()");
    await evaluate("document.getElementById('open-crude').click()");
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate("document.querySelectorAll('.crude-hit').length > 0")) break;
      await delay(100);
    }
    assert.equal(await evaluate("document.getElementById('crude-dialog').open"), true);
    assert.ok(await evaluate("document.querySelectorAll('.crude-hit').length > 10"), "published crude curve must render");
    const liveCrude = await evaluate("window.BESFUEL_CRUDE_DATA");
    crudeModel.validateSnapshot(liveCrude);
    assert.equal(await evaluate("document.getElementById('crude-source').textContent"),
      crudeModel.providers[crudeModel.providerId(liveCrude.series.wti)].displayName + " ↗");
    assert.ok(await evaluate("document.getElementById('crude-dialog').scrollWidth <= document.getElementById('crude-dialog').clientWidth"));
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
