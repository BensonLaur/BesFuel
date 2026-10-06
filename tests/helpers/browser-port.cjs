const fs = require("node:fs");

function readDevToolsPort(file, readFile = fs.readFileSync) {
  let contents;
  try {
    contents = readFile(file, "utf8");
  } catch (error) {
    // Edge can create and briefly lock this file while starting on Windows.
    if (error.code === "ENOENT" || error.code === "EBUSY") return null;
    throw error;
  }
  // Wait for the full first line so a partially written port is never accepted.
  const match = contents.match(/^(\d+)\r?\n/);
  const port = match ? Number(match[1]) : NaN;
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

module.exports = { readDevToolsPort };
