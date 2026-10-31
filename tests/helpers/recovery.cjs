"use strict";
const fs = require("node:fs");
const path = require("node:path");
const directory = path.resolve(__dirname, "../fixtures/recovery-20261029");
const manifest = require("../fixtures/recovery-20261029/manifest.json");
const text = name => fs.readFileSync(path.join(directory, name), "utf8");
const bytes = name => fs.readFileSync(path.join(directory, name));
function reader(transform = value => value) {
  const find = url => {
    const file = manifest.files.find(file => file.url === url || file.urlPrefix && url.startsWith(file.urlPrefix));
    if (!file) throw new Error(`Unexpected recovery fixture URL: ${url}`);
    return file.name;
  };
  return {
    getText: async url => transform(text(find(url)), url),
    getBuffer: async url => ({ buffer: bytes(find(url)) })
  };
}
module.exports = { manifest, text, bytes, reader };
