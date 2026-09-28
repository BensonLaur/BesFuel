(function () {
  "use strict";

  let data = window.BESFUEL_DATA;
  const calc = window.BesFuelCalc;
  const gradeNames = { "92": "92 号汽油", "95": "95 号汽油", "98": "98 号汽油", diesel: "0 号柴油" };
  const $ = id => document.getElementById(id);
  const ui = {
    region: $("region"), grade: $("grade"), regionLabel: $("region-label"), gradeLabel: $("grade-label"),
    price: $("current-price"), priceDetail: $("price-detail"), effective: $("effective-time"),
    freshness: $("freshness"), source: $("price-source"), conversionSource: $("conversion-source"),
    sourceNote: $("source-note"), syncNote: $("sync-note"),
    nextWindow: $("next-window"), windowDetail: $("window-detail"),
    windowRuleSource: $("window-rule-source"), windowHolidaySource: $("window-holiday-source"),
    prediction: $("prediction-text"), predictionArrow: $("prediction-arrow"),
    predictionDetail: $("prediction-detail"), predictionSource: $("prediction-source"),
    distance: $("distance"), consumption: $("consumption"), tripPrice: $("trip-price"),
    restorePrice: $("restore-price"), priceMode: $("price-mode"),
    perKm: $("per-km"), total: $("trip-total"), calcNote: $("calc-note"),
    chart: $("chart-wrap"), historyRange: $("history-range"), historyCount: $("history-count"),
    historyNote: $("history-note"), supportDialog: $("support-dialog"),
    supportImage: $("support-image"), supportOpenImage: $("support-open-image"),
    supportSaveImage: $("support-save-image")
  };
  let manualTripPrice = false;
  let hideHistoryPoint = () => {};

  function readPreference(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }

  function savePreference(key, value) {
    try { localStorage.setItem(key, value); } catch (_) { /* The page also works without storage. */ }
  }

  function selectedRegion() { return data.regions[ui.region.value]; }
  function selectedGrade() { return selectedRegion()?.grades?.[ui.grade.value]; }
  function chinaDate() {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(new Date()).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  function priceExpired() {
    const until = selectedRegion()?.priceValidThrough;
    return Boolean(until && chinaDate() > until);
  }
  function referencePrice() {
    if (priceExpired()) return null;
    const price = selectedGrade()?.price;
    return typeof price === "number" && Number.isFinite(price) && price >= 0 ? price : null;
  }

  function snapshotAgeDays() {
    const checked = new Date((selectedRegion().checkedAt || data.checkedAt) + "T00:00:00");
    if (Number.isNaN(checked.getTime())) return null;
    return Math.floor((Date.now() - checked.getTime()) / 86400000);
  }

  function showPrice() {
    const region = selectedRegion();
    const price = referencePrice();
    const expired = priceExpired();
    ui.regionLabel.textContent = region.name;
    ui.gradeLabel.textContent = gradeNames[ui.grade.value];
    ui.price.textContent = price === null ? "—" : price.toFixed(2);
    ui.effective.textContent = expired ? "折算系数待复核" : price === null ? "暂无已核实报价" : region.effectiveLabel;
    ui.priceDetail.textContent = price === null
      ? expired ? "本价区的季节折算系数已到期，请等待重新核价；仍可手动输入实际加油价。" :
        "这一油号暂无可核实的官方参考价，仍可在下方手动输入实际加油价。"
      : region.priceScope;
    ui.source.href = region.source.url;
    ui.source.textContent = region.source.name + " ↗";
    ui.conversionSource.hidden = !region.conversionSource;
    if (region.conversionSource) ui.conversionSource.href = region.conversionSource.url;
    const checkedAt = region.checkedAt || data.checkedAt;
    ui.sourceNote.textContent = `${region.source.name}，数据核对日期：${checkedAt}。${region.priceScope}本站不会将历史快照称为实时价格。`;

    const age = snapshotAgeDays();
    ui.freshness.classList.toggle("stale", age === null || age > 3);
    ui.freshness.textContent = expired ? "待复核" : price === null ? "待补充" :
      age === null || age > 3 ? "请核对价格" : `${checkedAt} 已核对`;
  }

  function showAdjustment() {
    const national = data.nationalAdjustment || {};
    const windowData = national.nextAdjustment || {};
    const forecast = national.forecast || {};
    const todayIso = chinaDate();
    const windowReady = /^\d{4}-\d{2}-\d{2}$/.test(windowData.date || "") && windowData.date >= todayIso;
    ui.nextWindow.textContent = windowReady ? windowData.dateLabel : windowData.date ? "待重新核实" : "待核实";
    ui.windowDetail.textContent = windowReady
      ? "按每 10 个工作日及调休安排推算，并非正式调价公告"
      : windowData.date ? "上轮预计窗口已过，请等待新一期公告" : "以主管部门公告为准";
    for (const [link, url] of [[ui.windowRuleSource, windowData.sourceUrl], [ui.windowHolidaySource, windowData.holidaySourceUrl]]) {
      link.hidden = !windowReady || !/^https:\/\//.test(url || "");
      if (!link.hidden) link.href = url;
    }
    const age = (Date.parse(`${todayIso}T00:00:00Z`) - Date.parse(`${forecast.updatedAt}T00:00:00Z`)) / 86400000;
    // A stored forecast must disappear when its cycle changes or its calculation day gets old.
    const forecastReady = windowReady && forecast.description && forecast.windowDate === windowData.date && age >= 0 && age <= 2;
    ui.prediction.textContent = forecastReady ? forecast.description : "暂无近期可靠预估";
    ui.predictionArrow.hidden = !forecastReady || !["up", "down"].includes(forecast.direction);
    if (!ui.predictionArrow.hidden) {
      ui.predictionArrow.textContent = forecast.direction === "up" ? "↑" : "↓";
      ui.predictionArrow.className = `prediction-arrow ${forecast.direction}`;
    }
    ui.predictionDetail.textContent = forecastReady
      ? `${forecast.sourceName} · ${forecast.updatedAt} · 第 ${forecast.workday} 个工作日；仅供参考`
      : forecast.updatedAt ? "上次预测已过期，等待新一期市场数据" : "市场预测与正式价格分开显示";
    ui.predictionSource.hidden = !forecastReady || !/^https:\/\//.test(forecast.sourceUrl || "");
    if (!ui.predictionSource.hidden) ui.predictionSource.href = forecast.sourceUrl;
  }

  function syncTripPrice() {
    const price = referencePrice();
    manualTripPrice = false;
    ui.tripPrice.value = price === null ? "" : price.toFixed(2);
    ui.restorePrice.hidden = true;
    ui.priceMode.textContent = price === null
      ? "暂无这一油号的已核实参考价，请输入实际加油价。"
      : "默认采用本地收录的参考价，可改成加油站实际价格。";
    showCalculation();
  }

  function showCalculation() {
    const result = calc.calculate(ui.distance.value, ui.consumption.value, ui.tripPrice.value);
    ui.perKm.textContent = result.perKm === null ? "—" : result.perKm.toFixed(2);
    ui.total.textContent = result.total === null ? "—" : result.total.toFixed(2);
    ui.calcNote.textContent = result.perKm === null
      ? "请输入有效的百公里油耗和油价。"
      : result.total === null ? "输入本次里程后显示全程油费。" : "按输入的里程、平均油耗和油价估算，仅含燃油。";
  }

  function svgElement(name, attributes, text) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function showHistory() {
    const history = (selectedGrade()?.history || [])
      .filter(item => /^\d{4}-\d{2}-\d{2}$/.test(item.date) && Number.isFinite(item.price) && item.price >= 0)
      .sort((a, b) => a.date.localeCompare(b.date));
    hideHistoryPoint = () => {};
    ui.chart.replaceChildren();
    ui.historyCount.textContent = `${history.length} 条已核实记录`;
    if (!history.length) {
      const empty = document.createElement("p");
      empty.className = "chart-empty";
      empty.textContent = "暂无这一油号的已核实历史价格。";
      ui.chart.append(empty);
      ui.chart.setAttribute("aria-label", empty.textContent);
      ui.historyRange.textContent = "暂无数据";
      ui.historyNote.textContent = "补充价格记录后会自动生成阶梯趋势图。";
      return;
    }

    const width = 440, height = 190, left = 42, right = 17, top = 27, bottom = 30;
    const values = history.map(item => item.price);
    const last = history[history.length - 1];
    const low = Math.min(...values), high = Math.max(...values);
    const padding = Math.max(.12, (high - low) * .25);
    const min = Math.max(0, low - padding), max = high + padding;
    const x = index => history.length === 1 ? (left + width - right) / 2 : left + index * (width - left - right) / (history.length - 1);
    const y = value => top + (max - value) * (height - top - bottom) / (max - min);
    const svg = svgElement("svg", { viewBox: `0 0 ${width} ${height}`, "aria-hidden": "true", preserveAspectRatio: "xMidYMid meet" });
    for (const level of [0, .5, 1]) {
      const value = min + (max - min) * (1 - level);
      const yy = top + level * (height - top - bottom);
      svg.append(svgElement("line", { x1: left, y1: yy, x2: width - right, y2: yy, class: "chart-grid" }));
      svg.append(svgElement("text", { x: 3, y: yy + 3, class: "chart-text" }, value.toFixed(2)));
    }
    svg.append(svgElement("line", { x1: left, y1: y(last.price), x2: width - right, y2: y(last.price), class: "chart-latest-line" }));
    const guide = svgElement("line", { x1: 0, x2: 0, y1: top, y2: height - bottom, class: "chart-guide" });
    svg.append(guide);
    if (history.length > 1) {
      let path = `M ${x(0)} ${y(history[0].price)}`;
      for (let i = 1; i < history.length; i++) path += ` H ${x(i)} V ${y(history[i].price)}`;
      svg.append(svgElement("path", { d: path, class: "chart-path" }));
    }
    const points = history.map((item, index) => svgElement("circle", { cx: x(index), cy: y(item.price), r: index === history.length - 1 ? 5 : 3.5, class: "chart-point" }));
    points.forEach(point => svg.append(point));
    svg.append(svgElement("text", { x: x(history.length - 1), y: Math.max(18, y(last.price) - 12), "text-anchor": "middle", class: "chart-value" }, last.price.toFixed(2)));
    svg.append(svgElement("text", { x: x(0), y: height - 8, "text-anchor": "middle", class: "chart-text" }, history[0].date.slice(5)));
    if (history.length > 1) svg.append(svgElement("text", { x: x(history.length - 1), y: height - 8, "text-anchor": "middle", class: "chart-text" }, last.date.slice(5)));
    const tooltip = document.createElement("div");
    tooltip.className = "chart-tooltip";
    tooltip.hidden = true;
    tooltip.setAttribute("aria-hidden", "true");
    const tooltipDate = document.createElement("span");
    const tooltipPrice = document.createElement("strong");
    tooltip.append(tooltipDate, tooltipPrice);
    const hitLayer = document.createElement("div");
    hitLayer.className = "chart-hit-layer";
    const hits = [];
    const clearPoint = () => {
      tooltip.hidden = true;
      guide.classList.remove("active");
      points.forEach(point => point.classList.remove("active"));
    };
    hideHistoryPoint = clearPoint;
    function showPoint(index) {
      const item = history[index];
      tooltipDate.textContent = `${item.date} 生效`;
      tooltipPrice.textContent = `${item.price.toFixed(2)} 元/升`;
      tooltip.style.setProperty("--tooltip-x", `${x(index) / width * 100}%`);
      tooltip.hidden = false;
      guide.setAttribute("x1", String(x(index)));
      guide.setAttribute("x2", String(x(index)));
      guide.classList.add("active");
      points.forEach((point, pointIndex) => point.classList.toggle("active", pointIndex === index));
    }
    // Full-height slices make closely spaced price nodes easy to reach on touch screens.
    history.forEach((item, index) => {
      const start = index === 0 ? 0 : (x(index - 1) + x(index)) / 2;
      const end = index === history.length - 1 ? width : (x(index) + x(index + 1)) / 2;
      const hit = document.createElement("button");
      hit.type = "button";
      hit.className = "chart-hit";
      hit.tabIndex = index === 0 ? 0 : -1;
      hit.style.width = `${(end - start) / width * 100}%`;
      hit.setAttribute("aria-label", `${gradeNames[ui.grade.value]}，${item.date} 生效，${item.price.toFixed(2)} 元每升`);
      hit.addEventListener("pointerenter", event => { if (event.pointerType !== "touch") showPoint(index); });
      hit.addEventListener("pointerleave", event => {
        if (event.pointerType !== "touch" && !ui.chart.contains(document.activeElement)) clearPoint();
      });
      hit.addEventListener("focus", () => showPoint(index));
      hit.addEventListener("blur", event => { if (!ui.chart.contains(event.relatedTarget)) clearPoint(); });
      hit.addEventListener("click", () => { hit.focus(); showPoint(index); });
      hit.addEventListener("keydown", event => {
        if (event.key === "Escape") { clearPoint(); hit.blur(); return; }
        const next = event.key === "ArrowRight" ? index + 1 : event.key === "ArrowLeft" ? index - 1 : -1;
        if (next >= 0 && next < hits.length) { event.preventDefault(); hits[next].focus(); }
      });
      hits.push(hit);
      hitLayer.append(hit);
    });
    ui.chart.append(svg, hitLayer, tooltip);
    ui.chart.setAttribute("aria-label", `${gradeNames[ui.grade.value]}，从 ${history[0].date} 到 ${last.date}，共 ${history.length} 条价格记录；最新 ${last.price.toFixed(2)} 元每升`);
    ui.historyRange.textContent = history.length === 1 ? history[0].date : `${history[0].date} 至 ${last.date}`;
    ui.historyNote.textContent = history.length === 1
      ? "轻点或聚焦节点可查看日期和价格；至少两次调价记录才能形成趋势。"
      : "浅色横虚线标出最新价；悬停、轻点或聚焦节点可查看调价日期和价格。";
  }

  function refresh(preserveTripPrice = false) {
    showPrice(); showAdjustment(); showHistory();
    if (preserveTripPrice && manualTripPrice) showCalculation();
    else syncTripPrice();
  }

  function populateRegions() {
    const selected = ui.region.value;
    ui.region.replaceChildren();
    Object.entries(data.regions)
      .sort(([leftKey, left], [rightKey, right]) =>
        (leftKey === "guangdong" ? -1 : rightKey === "guangdong" ? 1 :
          left.name.localeCompare(right.name, "zh-CN")))
      .forEach(([key, region]) => ui.region.add(new Option(region.name, key)));
    if (data.regions[selected]) ui.region.value = selected;
  }

  function selectSupportMethod(method) {
    const methods = {
      wechat: { name: "微信", payee: "Benson(**城)" },
      alipay: { name: "支付宝", payee: "Bes软件" }
    };
    const selected = methods[method];
    if (!selected) return;
    const path = `resources/support/${method}.png`;
    ui.supportImage.src = path;
    ui.supportImage.alt = `${selected.name}收款原图，收款主体 ${selected.payee}`;
    ui.supportOpenImage.href = path;
    ui.supportSaveImage.href = path;
    ui.supportSaveImage.download = `BesFuel-${method}.png`;
    document.querySelectorAll(".support-method").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.method === method));
    });
  }

  async function checkPublishedSnapshot() {
    if (!/^https?:$/.test(location.protocol)) {
      ui.syncNote.textContent = "本地模式：运行数据更新脚本后重新打开页面即可更新。";
      return;
    }
    ui.syncNote.textContent = "正在后台检查站点数据文件…";
    try {
      const response = await fetch("data/prices.json", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const fresh = await response.json();
      if (fresh.version !== 2 || !fresh.nationalAdjustment || !fresh.regions || !fresh.regions[ui.region.value]) throw new Error("数据格式不正确");
      if (fresh.checkedAt < data.checkedAt) {
        ui.syncNote.textContent = "站点数据文件较旧，继续显示已加载的快照。";
        return;
      }
      const changed = JSON.stringify(fresh) !== JSON.stringify(data);
      if (changed) {
        data = fresh;
        populateRegions();
        refresh(true);
      }
      ui.syncNote.textContent = changed ? "已更新页面数据，来源与核对日期见下方。" : "已读取站点最新数据文件。";
    } catch (_) {
      ui.syncNote.textContent = "检查更新失败，继续显示已加载的价格快照。";
    }
  }

  // A cached v1 script can still show prices until the fresh v2 JSON arrives.
  if (!data?.regions || !calc) {
    ui.priceDetail.textContent = "本地数据未能加载，请检查 data/prices.js 和 lib/calc.js。";
    return;
  }
  populateRegions();
  const savedRegion = readPreference("besfuel-region");
  const savedGrade = readPreference("besfuel-grade");
  const savedConsumption = readPreference("besfuel-consumption");
  if (savedRegion && data.regions[savedRegion]) ui.region.value = savedRegion;
  if (savedGrade && gradeNames[savedGrade]) ui.grade.value = savedGrade;
  if (savedConsumption !== null && calc.parseNonNegative(savedConsumption) !== null) ui.consumption.value = savedConsumption;
  ui.region.addEventListener("change", () => { savePreference("besfuel-region", ui.region.value); refresh(); });
  ui.grade.addEventListener("change", () => { savePreference("besfuel-grade", ui.grade.value); refresh(); });
  ui.distance.addEventListener("input", showCalculation);
  ui.consumption.addEventListener("input", () => { savePreference("besfuel-consumption", ui.consumption.value); showCalculation(); });
  ui.tripPrice.addEventListener("input", () => {
    manualTripPrice = true;
    ui.restorePrice.hidden = referencePrice() === null;
    ui.priceMode.textContent = "正在按你输入的实际加油价估算。";
    showCalculation();
  });
  ui.restorePrice.addEventListener("click", syncTripPrice);
  document.addEventListener("pointerdown", event => { if (!ui.chart.contains(event.target)) hideHistoryPoint(); });
  $("open-support").addEventListener("click", () => {
    selectSupportMethod("wechat");
    ui.supportDialog.showModal();
    $("close-support").focus();
  });
  $("close-support").addEventListener("click", () => ui.supportDialog.close());
  document.querySelectorAll(".support-method").forEach(button => {
    button.addEventListener("click", () => selectSupportMethod(button.dataset.method));
  });
  refresh();
  checkPublishedSnapshot();
})();
