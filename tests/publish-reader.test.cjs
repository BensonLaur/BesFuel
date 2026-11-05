"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { windowsCurl } = require("../scripts/publish-reader.cjs");
const { makeReader } = require("../scripts/update-regions.cjs");

test("Windows attachment reader ignores invalid filename metadata and retains strict HTTPS", { skip: process.platform !== "win32" }, async () => {
  let tempDirectory;
  const response = await windowsCurl("https://fgw.hunan.gov.cn/prices.xls", {}, async (command, args, options) => {
    assert.equal(command, "curl.exe");
    assert.equal(args[args.indexOf("--proto") + 1], "=https");
    assert.ok(!args.some(arg => ["-k", "--insecure", "-L", "--location"].includes(arg)));
    assert.ok(options.timeout <= 23000);
    const body = args[args.indexOf("--output") + 1];
    tempDirectory = require("node:path").dirname(body);
    fs.writeFileSync(body, Buffer.from("d0cf11e0a1b11ae1", "hex"));
    fs.writeFileSync(args[args.indexOf("--dump-header") + 1],
      "HTTP/1.1 200 Connection established\r\n\r\nHTTP/1.1 200 OK\r\n" +
      "Content-Type: application/vnd.ms-excel\r\nContent-Disposition: attachment; filename=price\u0001.xls\r\n\r\n");
    return { stdout: "200" };
  });
  assert.equal(response.headers.get("content-type"), "application/vnd.ms-excel");
  assert.equal(Buffer.from(await response.arrayBuffer()).toString("hex"), "d0cf11e0a1b11ae1");
  assert.equal(fs.existsSync(tempDirectory), false);
});

test("Windows compatibility transport cannot grant redirects access to another host", { skip: process.platform !== "win32" }, async () => {
  let calls = 0;
  const reader = makeReader(["fgw.hunan.gov.cn"], { fetcher: (url, options) => windowsCurl(url, options, async (_, args) => {
    calls++;
    fs.writeFileSync(args[args.indexOf("--output") + 1], "");
    fs.writeFileSync(args[args.indexOf("--dump-header") + 1],
      "HTTP/1.1 302 Found\r\nLocation: https://evil.example/file.xls\r\n\r\n");
    return { stdout: "302" };
  }) });
  await assert.rejects(reader.getBuffer("https://fgw.hunan.gov.cn/prices.xls"), /非允许的官方地址/);
  assert.equal(calls, 1);
});

test("Windows HTTPS compatibility is limited to the two official hosts", async () => {
  for (const url of ["https://evil.example/prices.xls", "http://fgw.hunan.gov.cn/prices.xls", "https://user:pass@fgw.hunan.gov.cn/prices.xls"]) {
    await assert.rejects(windowsCurl(url, {}, async () => assert.fail("must not launch curl")), /仅江西、湖南官网/);
  }
});
