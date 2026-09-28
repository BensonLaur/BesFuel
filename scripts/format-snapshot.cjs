const fs = require("node:fs");
const { writeSnapshot } = require("./update-regions.cjs");

const [jsonPath, scriptPath] = process.argv.slice(2);
if (!jsonPath || !scriptPath) {
  console.error("Usage: node scripts/format-snapshot.cjs <prices.json> <prices.js>");
  process.exitCode = 1;
} else {
  try {
    writeSnapshot(JSON.parse(fs.readFileSync(jsonPath, "utf8")), jsonPath, scriptPath);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
