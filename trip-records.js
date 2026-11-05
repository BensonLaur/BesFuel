(function () {
  "use strict";
  const model = window.BesFuelTripRecords;
  const $ = id => document.getElementById(id);
  const dialog = $("trip-record-dialog"), details = $("trip-records"), rows = $("trip-record-rows");
  const minutes = $("trip-minutes"), note = $("trip-record-note");
  let draft = null, deleted = null;
  const number = value => String(value);
  const date = value => new Date(value).toLocaleString("sv-SE", { hour12: false });
  function message(id, value) { $(id).textContent = value; $(id).hidden = !value; }
  function element(tag, value, className) {
    const node = document.createElement(tag);
    node.textContent = value;
    if (className) node.className = className;
    return node;
  }
  function cell(row, label, value) {
    const node = element("td", value);
    node.dataset.label = label;
    node.setAttribute("role", "cell");
    row.append(node);
    return node;
  }
  function render() {
    try {
      const records = model.readRecords(localStorage);
      rows.replaceChildren();
      for (const record of records) {
        const row = document.createElement("tr");
        row.setAttribute("role", "row");
        row.dataset.recordId = record.id;
        const trip = cell(row, "行程", "");
        trip.className = "record-trip";
        trip.append(element("strong", `${number(record.distance)} 公里`));
        if (record.note) trip.append(element("span", record.note, "record-route"));
        trip.append(element("small", `${record.region} · ${record.grade}`));
        cell(row, "平均油耗 · 升/百公里", number(record.consumption));
        cell(row, "计算油价 · 元/升", number(record.price));
        cell(row, "每公里油费 · 元/公里", record.perKm.toFixed(2));
        cell(row, "本次总油费 · 元", record.total.toFixed(2)).className = "record-total";
        cell(row, "耗时 · 分钟", record.minutes === null ? "未填写" : number(record.minutes));
        const time = document.createElement("time");
        time.dateTime = record.createdAt;
        time.textContent = date(record.createdAt);
        cell(row, "记录时间", "").append(time);
        const remove = element("button", "删除", "record-delete");
        remove.type = "button";
        remove.dataset.deleteRecord = record.id;
        remove.setAttribute("aria-label", `删除${record.note ? "「" + record.note + "」" : number(record.distance) + " 公里"}记录，${date(record.createdAt)}`);
        cell(row, "操作", "").append(remove);
        rows.append(row);
      }
      $("trip-record-count").textContent = String(records.length);
      $("records-empty").hidden = records.length !== 0;
      $("records-table-wrap").hidden = records.length === 0;
      message("records-error", "");
      return records;
    } catch (_) {
      $("trip-record-count").textContent = "—";
      $("records-empty").hidden = true;
      $("records-table-wrap").hidden = true;
      message("records-error", "暂时无法读取记录，浏览器存储可能不可用或记录格式异常。原有内容已保留，请稍后重试。");
      return [];
    }
  }
  $("add-trip-record").addEventListener("click", () => {
    // Freeze the visible inputs now: background reference-price updates must
    // not change the trip the user is about to confirm.
    draft = { distance: $("distance").value, consumption: $("consumption").value, price: $("trip-price").value,
      region: $("region").selectedOptions[0]?.textContent || "", grade: $("grade").selectedOptions[0]?.textContent || "" };
    const result = window.BesFuelCalc.calculate(draft.distance, draft.consumption, draft.price);
    if (result.total === null) { draft = null; return; }
    $("trip-record-form").reset();
    message("record-save-error", "");
    $("trip-record-preview").textContent = `${number(Number(draft.distance))} 公里 · ${number(Number(draft.consumption))} 升/百公里 · 油价 ${number(Number(draft.price))} 元/升\n本次油费 ${result.total.toFixed(2)} 元`;
    dialog.showModal();
    minutes.focus();
  });
  $("trip-record-form").addEventListener("submit", event => {
    event.preventDefault();
    if (!draft) return;
    let record;
    try {
      if (minutes.validity.badInput) throw new Error("耗时请输入大于 0 的分钟数，或留空。");
      record = model.createRecord(draft, { minutes: minutes.value, note: note.value });
    } catch (error) { message("record-save-error", error.message); minutes.focus(); return; }
    try {
      model.addRecord(localStorage, record);
    } catch (_) {
      message("record-save-error", "保存失败：浏览器存储不可用、已满或原记录无法读取。原有记录未改动，请稍后重试。");
      return;
    }
    deleted = null;
    $("record-feedback").hidden = true;
    render();
    draft = null;
    dialog.close();
    message("record-status", "已保存，可在下方「计算记录」中展开查看。");
  });
  for (const field of [minutes, note]) field.addEventListener("input", () => message("record-save-error", ""));
  for (const id of ["close-trip-record", "cancel-trip-record"]) $(id).addEventListener("click", () => { draft = null; dialog.close(); });
  dialog.addEventListener("cancel", () => { draft = null; });
  dialog.addEventListener("close", () => {
    // A previous close event may arrive after a quick reopen. It must not clear
    // the new draft or move focus out of the currently open dialog.
    if (!dialog.open) { draft = null; $("add-trip-record").focus(); }
  });
  rows.addEventListener("click", event => {
    const button = event.target.closest("button[data-delete-record]");
    if (!button) return;
    const index = [...rows.children].indexOf(button.closest("tr"));
    try {
      const record = model.readRecords(localStorage).find(item => item.id === button.dataset.deleteRecord);
      if (!record) { render(); return; }
      model.removeRecord(localStorage, record.id);
      deleted = record;
      render();
      $("record-feedback-text").textContent = "已删除这条记录。";
      $("record-feedback").hidden = false;
      const buttons = rows.querySelectorAll(".record-delete");
      (buttons[Math.min(index, buttons.length - 1)] || $("trip-records-toggle")).focus();
    } catch (_) { message("records-error", "删除失败，记录未改动，请稍后重试。"); }
  });
  $("undo-trip-delete").addEventListener("click", () => {
    if (!deleted) return;
    try {
      model.addRecord(localStorage, deleted);
      deleted = null;
      $("record-feedback").hidden = true;
      render();
      $("trip-records-toggle").focus();
    } catch (_) { message("records-error", "未能撤销删除，存储不可用或这条记录已存在。请刷新后查看。"); }
  });
  window.addEventListener("storage", event => {
    if (event.key === model.storageKey || event.key === null) render();
  });
  render();
})();
