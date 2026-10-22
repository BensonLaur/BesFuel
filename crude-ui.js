(function () {
  "use strict";
  const model = window.BesFuelCrude;
  const $ = id => document.getElementById(id);
  const dialog = $("crude-dialog");
  if (!dialog || !model) return;
  let snapshot = null, selected = "wti", days = 30, syncMessage = "", request = null;
  let clearPoint = () => {};
  try { snapshot = model.validateSnapshot(window.BESFUEL_CRUDE_DATA); } catch (_) { /* An unavailable optional dataset must not affect local fuel prices. */ }

  function timestamp(value) {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).format(new Date(value));
  }
  function element(name, attributes = {}, text) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function drawChart(view, name) {
    const chart = $("crude-chart");
    const focusedDate = chart.querySelector(".crude-hit:focus")?.dataset.date;
    chart.replaceChildren();
    clearPoint = () => {};
    const points = view.points;
    if (!points.length) return;
    const width = Math.max(260, chart.clientWidth), height = chart.clientHeight;
    const left = 45, right = 18, top = 37, bottom = 29;
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const values = points.map(point => point.price);
    const low = Math.min(...values), high = Math.max(...values), padding = Math.max((high - low) * .16, .6);
    const min = low - padding, max = high + padding;
    const firstTime = Date.parse(points[0].date), lastTime = Date.parse(points.at(-1).date);
    const x = index => left + (points.length === 1 ? plotWidth / 2 : (Date.parse(points[index].date) - firstTime) / (lastTime - firstTime) * plotWidth);
    const y = price => top + (max - price) / (max - min) * plotHeight;
    const svg = element("svg", { viewBox: `0 0 ${width} ${height}`, "aria-hidden": "true" });
    const defs = element("defs");
    const gradient = element("linearGradient", { id: "crude-fill", x1: "0", y1: "0", x2: "0", y2: "1" });
    gradient.append(element("stop", { offset: "0%", "stop-color": "#70bb96", "stop-opacity": ".28" }),
      element("stop", { offset: "100%", "stop-color": "#70bb96", "stop-opacity": ".02" }));
    defs.append(gradient); svg.append(defs);
    for (let row = 0; row <= 3; row++) {
      const value = min + (max - min) * row / 3, cy = y(value);
      svg.append(element("line", { x1: left, x2: width - right, y1: cy, y2: cy, class: "crude-grid" }),
        element("text", { x: left - 9, y: cy + 4, "text-anchor": "end", class: "crude-axis" }, value.toFixed(1)));
    }
    const daily = points.filter(point => point.kind === "daily");
    const line = daily.map((point, index) => `${index ? "L" : "M"} ${x(index)} ${y(point.price)}`).join(" ");
    if (daily.length) {
      const area = `${line} L ${x(daily.length - 1)} ${top + plotHeight} L ${x(0)} ${top + plotHeight} Z`;
      svg.append(element("path", { d: area, fill: "url(#crude-fill)" }), element("path", { d: line, class: "crude-line" }));
    }
    if (view.isIntraday && daily.length) {
      const index = points.length - 1;
      svg.append(element("path", { d: `M ${x(index - 1)} ${y(points[index - 1].price)} L ${x(index)} ${y(points[index].price)}`, class: "crude-line provisional" }));
    }
    const latest = points.at(-1);
    svg.append(element("line", { x1: left, x2: width - right, y1: y(latest.price), y2: y(latest.price), class: "crude-reference-line" }));
    const guide = element("line", { x1: left, x2: left, y1: top, y2: top + plotHeight, class: "crude-guide", visibility: "hidden" });
    const active = element("circle", { cx: left, cy: top, r: 5, class: "crude-active-point", visibility: "hidden" });
    svg.append(guide, active,
      element("circle", { cx: x(points.length - 1), cy: y(latest.price), r: 4.5, class: `crude-endpoint${latest.kind === "intraday" ? " provisional" : ""}` }));
    const tickCount = width < 440 ? 3 : 5;
    const ticks = [...new Set(Array.from({ length: tickCount }, (_, i) => Math.round(i * (points.length - 1) / (tickCount - 1))))];
    for (const index of ticks) svg.append(element("text", { x: x(index), y: height - 7, "text-anchor": "middle", class: "crude-axis" }, points[index].date.slice(5).replace("-", "/")));
    const tooltip = document.createElement("div");
    tooltip.className = "crude-tooltip"; tooltip.hidden = true;
    const hitLayer = document.createElement("div"); hitLayer.className = "crude-hits";
    const hits = [];
    clearPoint = () => {
      tooltip.hidden = true;
      guide.setAttribute("visibility", "hidden"); active.setAttribute("visibility", "hidden");
    };
    const show = index => {
      const point = points[index];
      tooltip.textContent = `${point.date} · ${point.price.toFixed(2)} 美元/桶${point.kind === "intraday" ? " · 盘中快照" : " · 已完成日线"}`;
      tooltip.hidden = false;
      tooltip.style.left = `${Math.max(0, Math.min(chart.clientWidth - tooltip.offsetWidth, x(index) - tooltip.offsetWidth / 2))}px`;
      guide.setAttribute("x1", x(index)); guide.setAttribute("x2", x(index)); guide.setAttribute("visibility", "visible");
      active.setAttribute("cx", x(index)); active.setAttribute("cy", y(point.price)); active.setAttribute("visibility", "visible");
    };
    points.forEach((point, index) => {
      const start = index ? (x(index - 1) + x(index)) / 2 : 0;
      const end = index === points.length - 1 ? width : (x(index) + x(index + 1)) / 2;
      const hit = document.createElement("button");
      hit.type = "button"; hit.className = "crude-hit";
      hit.dataset.date = point.date;
      hit.style.left = `${start / width * 100}%`; hit.style.width = `${(end - start) / width * 100}%`;
      hit.tabIndex = index === points.length - 1 ? 0 : -1;
      hit.setAttribute("aria-label", `${name}，${point.date}，${point.price.toFixed(2)} 美元每桶，${point.kind === "intraday" ? "盘中快照" : "已完成日线"}`);
      hit.addEventListener("pointerenter", event => { if (event.pointerType !== "touch") show(index); });
      hit.addEventListener("pointerleave", event => { if (event.pointerType !== "touch" && !chart.contains(document.activeElement)) clearPoint(); });
      hit.addEventListener("click", () => { hit.focus(); show(index); });
      hit.addEventListener("focus", () => { hits.forEach(button => { button.tabIndex = button === hit ? 0 : -1; }); show(index); });
      hit.addEventListener("blur", event => { if (!chart.contains(event.relatedTarget)) clearPoint(); });
      hit.addEventListener("keydown", event => {
        const target = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: points.length - 1 }[event.key];
        if (target !== undefined) {
          event.preventDefault();
          const next = Math.max(0, Math.min(hits.length - 1, target));
          hits[next].focus({ preventScroll: true });
          // End/Home may keep the same focus after a pointer changed the tooltip.
          show(next);
        }
      });
      hits.push(hit); hitLayer.append(hit);
    });
    chart.append(svg, hitLayer, tooltip);
    chart.setAttribute("aria-label", `${name}，${points[0].date} 至 ${latest.date}，${points.length} 个参考点；最新 ${latest.price.toFixed(2)} 美元每桶`);
    // Resize and snapshot refresh replace the buttons; retain keyboard selection by date.
    if (focusedDate) {
      const index = points.findIndex(point => point.date === focusedDate);
      hits[index < 0 ? hits.length - 1 : index].focus({ preventScroll: true });
    }
  }

  function render() {
    if (!dialog.open) return;
    const series = snapshot?.series[selected];
    $("crude-source").hidden = !series;
    $("crude-live").href = selected === "wti" ? "https://www.tradingview.com/symbols/NYMEX-CL1!/" : "https://www.tradingview.com/symbols/UKOIL/";
    $("crude-series-label").textContent = selected === "wti"
      ? "WTI 原油（West Texas Intermediate；主要代表美国市场）"
      : "布伦特原油（Brent Crude Oil；主要代表欧洲及全球海运原油市场）";
    if (!series) {
      $("crude-price").textContent = "—"; $("crude-change").textContent = "";
      $("crude-comparison").textContent = "暂无可用价格"; $("crude-kind").textContent = "等待数据";
      $("crude-asof").textContent = "尚无行情日期"; $("crude-collected").textContent = "";
      $("crude-range").textContent = "暂无数据";
      $("crude-chart").replaceChildren();
      const empty = document.createElement("p"); empty.className = "crude-empty";
      empty.textContent = "原油数据暂未加载，国内油价和油费计算仍可正常使用。";
      $("crude-chart").append(empty); $("crude-chart").setAttribute("aria-label", empty.textContent);
      $("crude-status").hidden = !syncMessage; $("crude-status").textContent = syncMessage;
      return;
    }
    const view = model.view(series, days);
    const provider = model.providers[model.providerId(series)];
    $("crude-price").textContent = view.quote.price.toFixed(2);
    const sign = view.difference > 0 ? "+" : "";
    $("crude-change").textContent = `${sign}${view.difference.toFixed(2)} (${sign}${view.percent.toFixed(2)}%)`;
    $("crude-change").className = view.difference > 0 ? "up" : view.difference < 0 ? "down" : "";
    $("crude-comparison").textContent = `较 ${view.previous.date} 已完成日线`;
    $("crude-kind").textContent = view.isIntraday ? "盘中快照 · 未收盘" : "已完成日线";
    $("crude-kind").classList.toggle("provisional", view.isIntraday);
    $("crude-asof").textContent = `行情日期 ${view.quote.date}`;
    $("crude-collected").textContent = `${timestamp(series.fetchedAt)} 采集 · 北京时间`;
    const info = snapshot.collection;
    let sourceMessage = "";
    if (info?.outcome === "retained") sourceMessage = `最近一次更新未成功（${timestamp(info.checkedAt)} 检查），继续使用 ${provider.displayName} 的旧快照。`;
    else if (info?.switchedFrom) sourceMessage = `数据来源已由 ${model.providers[info.switchedFrom].displayName} 切换为 ${provider.displayName}，曲线已整体更新。`;
    else if (info?.mode === "auto" && info.activeProvider !== "eastmoney") sourceMessage = `当前使用备用来源 ${provider.displayName}。`;
    $("crude-status").textContent = [view.stale ? `行情较旧；最新参考日期 ${view.quote.date}。` : "", sourceMessage, syncMessage].filter(Boolean).join(" ");
    $("crude-status").hidden = !$("crude-status").textContent;
    $("crude-source").href = series.sourceUrl;
    $("crude-source").textContent = `${provider.displayName} ↗`;
    $("crude-basis").textContent = series.basis === "cfd-daily"
      ? "CFD 差价合约日线 · 第三方参考" : series.basis === "nymex-futures-daily"
        ? "NYMEX 期货日线 · 第三方参考" : "期货连续日线 · 第三方参考";
    $("crude-range").textContent = `${view.points[0].date} — ${view.quote.date}`;
    drawChart(view, series.name);
  }

  async function checkSnapshot() {
    if (!/^https?:$/.test(location.protocol)) return;
    request?.abort();
    const controller = new AbortController(); request = controller;
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch("data/crude-prices.json", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("原油快照不可用");
      const fresh = model.validateSnapshot(await response.json());
      if (request !== controller || !dialog.open) return;
      if (!snapshot) snapshot = fresh;
      else {
        const canReplace = (fresh.collection?.checkedAt || fresh.updatedAt) >= (snapshot.collection?.checkedAt || snapshot.updatedAt) &&
          fresh.updatedAt >= snapshot.updatedAt && Object.keys(snapshot.series).every(id => {
          const old = snapshot.series[id], next = fresh.series[id];
          return next.fetchedAt >= old.fetchedAt &&
            (next.intraday || next.history.at(-1)).date >= (old.intraday || old.history.at(-1)).date;
        });
        if (canReplace) snapshot = fresh;
      }
      syncMessage = "";
    } catch (_) {
      if (request !== controller || !dialog.open) return;
      syncMessage = snapshot ? "检查更新未成功，继续显示已加载的快照。" : "暂时无法取得原油数据，请稍后再试。";
    } finally { clearTimeout(timeout); if (request === controller && dialog.open) render(); }
  }

  $("open-crude").addEventListener("click", () => {
    syncMessage = ""; dialog.showModal(); render(); $("close-crude").focus({ preventScroll: true }); checkSnapshot();
  });
  $("close-crude").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    // A queued close event may arrive after reopening; preserve the new request.
    if (dialog.open) return;
    request?.abort(); request = null; clearPoint();
  });
  dialog.addEventListener("click", event => {
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
  });
  dialog.addEventListener("pointerdown", event => { if (!$("crude-chart").contains(event.target)) clearPoint(); });
  document.querySelectorAll("[data-crude-series]").forEach(button => button.addEventListener("click", () => {
    selected = button.dataset.crudeSeries;
    document.querySelectorAll("[data-crude-series]").forEach(item => item.setAttribute("aria-pressed", String(item === button)));
    render();
  }));
  document.querySelectorAll("[data-crude-days]").forEach(button => button.addEventListener("click", () => {
    days = Number(button.dataset.crudeDays);
    document.querySelectorAll("[data-crude-days]").forEach(item => item.setAttribute("aria-pressed", String(item === button)));
    render();
  }));
  if (typeof ResizeObserver !== "undefined") {
    let frame;
    new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(render); }).observe(dialog);
  }
})();
