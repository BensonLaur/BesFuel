const { isValidDate } = require("./date-utils.cjs");

// The 2026 holiday and makeup-day schedule is from 国办发明电〔2025〕7号.
// Only dates after the latest published notice are needed for this release.
const holidays = new Set([
  "2026-09-25", "2026-09-26", "2026-09-27",
  "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04",
  "2026-10-05", "2026-10-06", "2026-10-07"
]);
const makeupDays = new Set(["2026-10-10"]);

function nextDate(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function isWorkday(date) {
  if (!isValidDate(date) || !date.startsWith("2026-")) return false;
  if (makeupDays.has(date)) return true;
  if (holidays.has(date)) return false;
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

function nextWindowAfter(publishedDate, today) {
  if (!isValidDate(publishedDate) || !publishedDate.startsWith("2026-") || !isValidDate(today) || publishedDate > today) return null;
  let date = publishedDate;
  let workdays = 0;
  while (date < "2027-01-01") {
    date = nextDate(date);
    if (!isWorkday(date)) continue;
    workdays += 1;
    if (workdays === 10) {
      if (date >= today) return date;
      workdays = 0;
    }
  }
  // A later year's official holiday schedule must be recorded before projecting into it.
  return null;
}

if (require.main === module) {
  const date = nextWindowAfter(process.argv[2], process.argv[3]);
  process.stdout.write(date || "");
}

module.exports = { isWorkday, nextWindowAfter };
