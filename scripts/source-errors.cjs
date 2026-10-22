"use strict";

function errorChain(error) {
  const rows = [], seen = new Set();
  function visit(value) {
    if (!value || seen.has(value) || rows.length >= 8) return;
    seen.add(value);
    rows.push({ name: value.name || "Error", code: value.code || "",
      message: String(value.message || value).replace(/[\r\n]+/g, " ").slice(0, 1200) });
    visit(value.cause);
    if (Array.isArray(value.errors)) value.errors.forEach(visit);
  }
  visit(error);
  return rows;
}

function requestError(error, url, elapsedMs) {
  if (error.details) return error;
  const causes = errorChain(error);
  const codes = causes.map(item => item.code || item.name).join(" ");
  const category = error.status ? "http" : /CERT|SSL|TLS/.test(codes) ? "tls" :
    /ENOTFOUND|EAI_AGAIN/.test(codes) ? "dns" : /TIMEOUT|TimeoutError|AbortError/.test(codes) ? "timeout" : "network";
  const detail = causes.map(item => `${item.code || item.name}: ${item.message}`).join(" ← ");
  const wrapped = new Error(`[${category}] ${url}；${elapsedMs}ms；${detail}`, { cause: error });
  wrapped.details = { category, url, elapsedMs, status: error.status || null, causes };
  return wrapped;
}

function failureResult(id, error) {
  return { id, ok: false, error: error.message,
    failure: error.details || { category: "validation", causes: errorChain(error) } };
}

module.exports = { errorChain, requestError, failureResult };
