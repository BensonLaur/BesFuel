(function (root) {
  function validDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  function buildHistory(region, grade, today) {
    const entry = region.grades?.[grade];
    const points = (entry?.history || [])
      .filter(item => validDate(item.date) && Number.isFinite(item.price) && item.price >= 0)
      .map(item => ({ ...item, kind: "price" }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const priceCount = points.length;
    const last = points.at(-1);
    const notice = region.latestNotice;
    // A verified unchanged decision is a separate observation, not a new price effective date.
    if (last && notice?.kind === "unchanged" && validDate(notice.date) && validDate(today) &&
        validDate(region.checkedAt) && notice.date > last.date && notice.date <= today &&
        notice.date <= region.checkedAt && notice.sourceUrl && entry.price === last.price &&
        (!region.priceValidThrough || notice.date <= region.priceValidThrough) &&
        !(region.historyGaps || []).some(gap => gap.date > last.date && gap.date <= notice.date)) {
      points.push({ date: notice.date, price: last.price, sourceUrl: notice.sourceUrl, kind: "unchanged" });
    }
    return { points, priceCount, noticeCount: points.length - priceCount };
  }

  const api = { buildHistory };
  root.BesFuelHistory = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
