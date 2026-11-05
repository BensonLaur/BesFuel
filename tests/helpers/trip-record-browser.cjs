"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

module.exports = async function checkTripRecords({ evaluate, send, setValue, screenshot }) {
  const click = id => evaluate(`(() => { const button = document.getElementById(${JSON.stringify(id)}); button.focus(); button.click(); })()`);
  const count = () => evaluate("document.getElementById('trip-record-count').textContent");
  const saved = () => evaluate("JSON.parse(localStorage.getItem('besfuel-trip-records-v1')).records");
  const submit = () => evaluate("document.getElementById('trip-record-form').requestSubmit()");
  const reload = async () => {
    await send("Page.reload");
    for (let i = 0; i < 100; i++) {
      if (await evaluate("!!window.BesFuelTripRecords && !!document.getElementById('region')?.options.length && document.readyState === 'complete'")) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("Trip record reload did not finish");
  };
  const capture = async name => {
    if (!screenshot) return;
    const target = path.parse(screenshot);
    const result = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(target.dir, `${target.name}-records-${name}${target.ext}`), Buffer.from(result.data, "base64"));
  };
  await setValue("region", "guangdong", "change");
  await setValue("grade", "92", "change");
  await setValue("distance", "", "input");
  assert.equal(await evaluate("document.getElementById('add-trip-record').disabled"), true);
  assert.equal(await evaluate("document.getElementById('trip-records').open"), false);
  await setValue("distance", "7", "input");
  await setValue("consumption", "11.9", "input");
  await setValue("trip-price", "8.91", "input");
  await click("add-trip-record");
  assert.equal(await evaluate("document.getElementById('trip-record-dialog').open"), true);
  assert.equal(await evaluate("document.activeElement.id"), "trip-minutes");
  await click("cancel-trip-record");
  assert.equal(await count(), "0");
  await click("add-trip-record");
  await setValue("trip-record-note", "上班 · 沿江路", "input");
  await evaluate("document.getElementById('trip-record-form').requestSubmit(); document.getElementById('trip-record-form').requestSubmit()");
  assert.equal(await count(), "1");
  assert.equal(await evaluate("document.getElementById('trip-records').open"), false);
  assert.equal((await saved())[0].minutes, null);
  assert.equal(await evaluate("document.activeElement.id"), "add-trip-record");
  await setValue("distance", "8.3", "input");
  await setValue("consumption", "10.1", "input");
  await click("add-trip-record");
  await setValue("trip-minutes", "-1", "input");
  await submit();
  assert.equal(await count(), "1");
  assert.equal(await evaluate("document.getElementById('record-save-error').hidden"), false);
  await setValue("trip-minutes", "35.5", "input");
  assert.equal(await evaluate("document.getElementById('record-save-error').hidden"), true);
  await setValue("trip-record-note", "下班 · 高架", "input");
  // Simulate a background price refresh while the confirmation is open.
  await setValue("trip-price", "9.12", "input");
  for (const width of [320, 390, 1280]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 850, deviceScaleFactor: 1, mobile: width < 600 });
    assert.ok(await evaluate("(() => { const dialog = document.getElementById('trip-record-dialog'); const box = dialog.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && dialog.scrollWidth <= dialog.clientWidth; })()"), `record dialog fits ${width}px`);
    await capture(`dialog-${width}`);
  }
  await submit();
  assert.equal((await saved())[0].price, 8.91);
  assert.equal((await saved())[0].minutes, 35.5);
  const records = await saved();
  assert.equal(records[1].total.toFixed(2), "7.42");
  await reload();
  assert.equal(await count(), "2");
  assert.equal(await evaluate("document.getElementById('trip-records').open"), false);
  assert.deepEqual(await saved(), records);
  await click("trip-records-toggle");
  assert.equal(await evaluate("document.querySelectorAll('.records-table th').length"), 8);
  assert.ok(await evaluate("document.getElementById('trip-record-rows').textContent.includes('未填写')"));
  for (const width of [320, 390, 1280]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
    await evaluate("document.getElementById('trip-records').scrollIntoView({block: 'center'})");
    assert.ok(await evaluate("document.documentElement.scrollWidth <= innerWidth"), `records fit ${width}px`);
    assert.equal(await evaluate("document.querySelectorAll('.record-delete').length"), 2);
    await capture(String(width));
  }
  await evaluate("document.querySelector('.record-delete').click()");
  assert.equal(await count(), "1");
  await click("undo-trip-delete");
  assert.deepEqual(await saved(), records);
  // Failed persistence must keep the modal open and retain all previous trips.
  await setValue("distance", "7", "input");
  await setValue("trip-price", "8.91", "input");
  await click("add-trip-record");
  await evaluate("window.originalRecordSetItem = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key === 'besfuel-trip-records-v1') throw new DOMException('full', 'QuotaExceededError'); return window.originalRecordSetItem.call(this, key, value); }");
  await submit();
  assert.equal(await evaluate("document.getElementById('trip-record-dialog').open"), true);
  assert.deepEqual(await saved(), records);
  assert.equal(await evaluate("document.getElementById('record-save-error').hidden"), false);
  await evaluate("Storage.prototype.setItem = window.originalRecordSetItem; delete window.originalRecordSetItem");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  assert.equal(await evaluate("document.getElementById('trip-record-dialog').open"), false);
  await evaluate("document.querySelector('.record-delete').click()");
  await reload();
  assert.equal(await count(), "1");
  await click("trip-records-toggle");
  await evaluate("document.querySelector('.record-delete').click()");
  assert.equal(await count(), "0");
  assert.equal(await evaluate("document.getElementById('records-empty').hidden"), false);
  assert.equal(await evaluate("document.getElementById('records-table-wrap').hidden"), true);
  // User notes remain inert text, including after persistence and rendering.
  await setValue("distance", "7", "input");
  await click("add-trip-record");
  await setValue("trip-record-note", '<img src=x onerror="window.tripNoteExecuted=true">', "input");
  await submit();
  assert.equal(await count(), "1");
  assert.equal(await evaluate("document.getElementById('trip-record-rows').querySelectorAll('img').length"), 0);
  assert.equal(await evaluate("window.tripNoteExecuted === true"), false);
  await evaluate("document.querySelector('.record-delete').click()");
};
