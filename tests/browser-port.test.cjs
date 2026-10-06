const assert = require("node:assert/strict");
const test = require("node:test");
const { readDevToolsPort } = require("./helpers/browser-port.cjs");

test("browser port polling tolerates a missing or locked file and then accepts the published port", () => {
  const reads = ["ENOENT", "EBUSY", "", "92", "9222", "9222\n/devtools/browser/test"];
  const readFile = () => {
    const value = reads.shift();
    if (value === "ENOENT" || value === "EBUSY") throw Object.assign(new Error(value), { code: value });
    return value;
  };
  for (let attempt = 0; attempt < 5; attempt++) assert.equal(readDevToolsPort("port-file", readFile), null);
  assert.equal(readDevToolsPort("port-file", readFile), 9222);
});

test("browser port polling rejects invalid ports and accepts both newline formats", () => {
  for (const contents of ["\n", "0\n", "65536\n", "-1\n", "1.5\n", "NaN\n", "Infinity\n"]) {
    assert.equal(readDevToolsPort("port-file", () => contents), null, contents);
  }
  for (const newline of ["\n", "\r\n"]) {
    assert.equal(readDevToolsPort("port-file", () => `65535${newline}/devtools/browser/test`), 65535);
  }
});

test("browser port polling reports unexpected filesystem errors immediately", () => {
  for (const code of ["EACCES", "EPERM", "EIO"]) {
    const error = Object.assign(new Error(code), { code });
    assert.throws(() => readDevToolsPort("port-file", () => { throw error; }), actual => actual === error);
  }
});
