(function (root) {
  function parseNonNegative(value) {
    if (value === null || value === undefined || String(value).trim() === "") return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function calculate(distanceInput, consumptionInput, priceInput) {
    const distance = parseNonNegative(distanceInput);
    const consumption = parseNonNegative(consumptionInput);
    const price = parseNonNegative(priceInput);
    const rawPerKm = consumption === null || price === null ? null : consumption * price / 100;
    const perKm = rawPerKm !== null && Number.isFinite(rawPerKm) ? rawPerKm : null;
    const rawTotal = perKm === null || distance === null ? null : perKm * distance;
    return {
      perKm,
      total: rawTotal !== null && Number.isFinite(rawTotal) ? rawTotal : null
    };
  }

  const api = { parseNonNegative, calculate };
  root.BesFuelCalc = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
