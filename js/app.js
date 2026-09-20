/*
 * 界面层：DOM 渲染与交互。
 * 业务判定一律调用 DiveRules（规则层），数据读写一律走 DiveStore（存储层），
 * 筛选、统计、时间线共用同一份过滤结果，刷新后从存储恢复。
 */
(function () {
  "use strict";

  const $ = sel => document.querySelector(sel);
  const R = window.DiveRules;
  const Store = window.DiveStore;

  // —— DOM ——
  const map = $("#map");
  const diveForm = $("#diveForm");
  const diveSelect = $("#diveSelect");
  const gateBox = $("#gate");
  const markForm = $("#markForm");
  const markFields = $("#markFields");
  const list = $("#list");
  const listTitle = $("#listTitle");
  const filterType = $("#filterType");
  const filterStatus = $("#filterStatus");
  const view = $("#view");
  const reviewBox = $("#reviewBox");
  const stats = $("#stats");

  const typeNames = { ceramic: "陶片", wood: "木构件", metal: "金属件", unknown: "未知物" };
  const statusNames = { pending: "待复核", approved: "已通过", invalid: "已失效" };

  // —— 状态 ——
  const state = Store.load();
  const prefs = loadPrefs();
  let selectedMarkId = null;
  let pendingPos = null;   // 地图点击待落点
  let diveDraft = null;   // “新潜次”未保存草稿
  const reviewDraft = { reviewer: "", exitChecked: false };

  function loadPrefs() {
    try {
      return JSON.parse(localStorage.getItem("zfl30.diveLog.ui") || "{}");
    } catch (err) {
      return {};
    }
  }
  function savePrefs() {
    localStorage.setItem("zfl30.diveLog.ui", JSON.stringify(prefs));
  }
  function persist() {
    Store.save(state);
  }

  // —— 工具 ——
  function esc(v) {
    return String(v ?? "").replace(/[&<>"']/g, s =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[s]));
  }
  function diveById(id) {
    return state.dives.find(d => d.id === id) || null;
  }
  function selectedMark() {
    return state.marks.find(m => m.id === selectedMarkId) || null;
  }
  function fmtTime(v) {
    if (!v) return "未登记";
    return String(v).slice(5, 16).replace("T", " "); // MM-DD HH:MM
  }
  function fillForm(form, obj) {
    Object.entries(obj).forEach(([k, v]) => {
      if (form.elements[k]) form.elements[k].value = v ?? "";
    });
  }
  function readDiveForm() {
    const f = diveForm.elements;
    const numOrEmpty = v => (v === "" ? "" : Number(v));
    return {
      code: f.code.value.trim(),
      plannedStart: f.plannedStart.value,
      plannedEnd: f.plannedEnd.value,
      diver1: f.diver1.value.trim(),
      diver2: f.diver2.value.trim(),
      startPressure: numOrEmpty(f.startPressure.value),
      endPressure: numOrEmpty(f.endPressure.value),
      tideHeight: numOrEmpty(f.tideHeight.value),
      actualExit: f.actualExit.value
    };
  }
  function currentDiveSnapshot() {
    // 表单正在编辑的潜次：已保存的那条，或新建草稿
    const id = diveForm.elements.id.value;
    return id ? diveById(id) : diveDraft;
  }

  // —— 筛选（列表、地图、时间线、统计共用）——
  function filteredMarks() {
    return state.marks.filter(m =>
      (!filterType.value || m.type === filterType.value) &&
      (!filterStatus.value || m.status === filterStatus.value)
    );
  }

  function render() {
    renderDiveSelect();
    renderGate();
    renderMap();
    renderReview();
    renderStats();
    if (view.value === "timeline") renderTimeline();
    else renderList(filteredMarks());
  }

  // —— 潜次选择与安全门槛 ——
  function renderDiveSelect() {
    // 先记下当前选择，再重建选项（重建会清空选择）
    const keep = diveSelect.value;
    diveSelect.innerHTML = state.dives.map(d =>
      `<option value="${d.id}">${esc(d.code)}${d.closed ? "（已闭潜）" : ""}</option>`
    ).join("");
    // 重建后显式恢复：原选中的潜次仍在则保留，否则回退第一条
    if (state.dives.some(d => d.id === keep)) diveSelect.value = keep;
    else diveSelect.value = state.dives.length ? state.dives[0].id : "";

    const m = markForm.elements.diveId;
    const markKeep = m.value;
    m.innerHTML = state.dives.map(d =>
      `<option value="${d.id}">${esc(d.code)}${d.closed ? "（已闭潜）" : ""}</option>`
    ).join("");
    if (state.dives.some(d => d.id === markKeep)) m.value = markKeep;
    else if (state.dives.length) m.value = state.dives[0].id;
  }

  function gateRow(ok, label, text) {
    return `<div class="check ${ok ? "ok" : "bad"}"><b>${ok ? "✓" : "✗"} ${label}</b><span>${esc(text)}</span></div>`;
  }

  function renderGate() {
    const snapshot = currentDiveSnapshot();
    const values = readDiveForm();
    const ev = R.evaluate(values);
    const c = ev.checks;
    gateBox.className = "gate " + (ev.ok ? "pass" : "fail");
    gateBox.innerHTML =
      gateRow(c.tide.ok, "潮汐窗口",
        c.tide.value === null ? "未登记潮高" : `潮高 ${c.tide.value}m（上限 ${R.TIDE_LIMIT_M}m）`) +
      gateRow(c.buddies.ok, "潜伴两人",
        c.buddies.value.length ? c.buddies.value.join("、") : "未登记潜水员") +
      gateRow(c.pressure.ok, "安全余压",
        c.pressure.value === null ? "未登记余压" : `返回余压 ${c.pressure.value} 巴（下限 ${R.MIN_RESIDUAL_BAR} 巴）`) +
      (ev.ok
        ? `<div class="gate-msg">满足闭潜条件，关联标记可送复核。</div>`
        : `<div class="gate-msg">${ev.violations.map(v => esc(v.message)).join("；")}——不得闭潜，标记只能进入待复核。</div>`) +
      (snapshot && snapshot.closed ? `<div class="closed-tag">该潜次已闭潜</div>` : "");
  }

  function loadDiveIntoForm(dive) {
    diveDraft = null;
    diveForm.elements.id.value = dive ? dive.id : "";
    if (dive) fillForm(diveForm, dive);
    renderGate();
  }

  diveSelect.onchange = () => loadDiveIntoForm(diveById(diveSelect.value));
  diveForm.addEventListener("input", renderGate);

  $("#newDiveBtn").onclick = () => {
    diveDraft = Store.newDive();
    diveForm.elements.id.value = "";
    fillForm(diveForm, diveDraft);
    renderGate();
  };

  diveForm.onsubmit = event => {
    event.preventDefault();
    const values = readDiveForm();
    if (!values.code) { alert("请填写潜次编号。"); return; }

    const id = diveForm.elements.id.value;
    const existing = id ? diveById(id) : null;
    const stamp = new Date().toISOString();

    if (existing) {
      const linked = state.marks.filter(m => m.diveId === existing.id && m.status !== "invalid");
      if (R.diveChanged(existing, values) && linked.length) {
        const ok = confirm(
          `潜次 ${values.code} 的登记信息已改动，关联的 ${linked.length} 个标记将立即失效。\n` +
          "旧值留档可查，但不再导出、不计入时间线。是否继续？"
        );
        if (!ok) return;
      }
      if (R.diveChanged(existing, values)) {
        const snapshot = {};
        R.DIVE_FIELDS.forEach(f => { snapshot[f] = existing[f]; });
        snapshot.closed = existing.closed;
        Store.archiveDive(existing, snapshot, stamp);
      }
      const changed = R.diveChanged(existing, values);
      Object.assign(existing, values);
      // 门槛不满足时不能保持闭潜状态
      existing.closed = existing.closed && R.evaluate(existing).ok;
      // 只有实质改动潜次，关联标记才立即失效；原样保存不影响标记
      if (changed) state.marks = R.invalidateMarks(state.marks, existing.id, stamp);
      selectedMarkId = null;
      persist();
      prefs.diveId = existing.id;
      savePrefs();
      diveSelect.value = existing.id;
      render();
      if (!R.evaluate(existing).ok) {
        alert("潜次已保存，但安全门槛未全部满足：不得闭潜，关联标记只能待复核。");
      }
    } else {
      const dive = diveDraft || Store.newDive();
      Object.assign(dive, values, { closed: false });
      diveDraft = null;
      state.dives.push(dive);
      persist();
      prefs.diveId = dive.id;
      savePrefs();
      diveForm.elements.id.value = dive.id;
      render();                 // 先重建出包含新潜次的选项
      diveSelect.value = dive.id; // 再选中，避免赋给尚不存在的 option 而静默失败
    }
  };

  $("#closeDiveBtn").onclick = () => {
    const id = diveForm.elements.id.value;
    const dive = id ? diveById(id) : null;
    if (!dive) { alert("请先选择并保存潜次，再登记闭潜。"); return; }
    if (R.diveChanged(dive, readDiveForm())) {
      alert("表单中有未保存的潜次改动，请先保存，再登记闭潜。");
      return;
    }
    const ev = R.evaluate(dive);
    if (!ev.ok) {
      alert("不得闭潜：\n· " + ev.violations.map(v => v.message).join("\n· "));
      return;
    }
    dive.closed = true;
    persist();
    render();
  };

  // —— 地图 ——
  for (let i = 0; i < 7; i++) {
    const rib = document.createElement("div");
    rib.className = "rib";
    rib.style.left = 28 + i * 7 + "%";
    map.appendChild(rib);
  }

  function renderMap() {
    map.querySelectorAll(".marker").forEach(el => el.remove());
    filteredMarks().forEach(mark => {
      const el = document.createElement("button");
      el.className = "marker " + mark.type + " st-" + mark.status +
        (mark.id === selectedMarkId ? " selected" : "");
      el.style.left = mark.x + "%";
      el.style.top = mark.y + "%";
      el.textContent = mark.status === "approved" ? "✓" : mark.status === "invalid" ? "✕" : mark.code.slice(0, 2);
      el.title = `${mark.code} · ${statusNames[mark.status]}`;
      el.onclick = event => { event.stopPropagation(); editMark(mark.id); };
      map.appendChild(el);
    });
  }

  map.addEventListener("click", event => {
    const rect = map.getBoundingClientRect();
    pendingPos = {
      x: Number(((event.clientX - rect.left) / rect.width * 100).toFixed(2)),
      y: Number(((event.clientY - rect.top) / rect.height * 100).toFixed(2))
    };
    selectedMarkId = null;
    markForm.reset();
    markForm.elements.id.value = "";
    markForm.elements.code.value = "M-" + String(state.marks.length + 1).padStart(3, "0");
    markFields.disabled = false;
    render();
  });

  // —— 标记表单 ——
  function editMark(id) {
    const found = state.marks.find(m => m.id === id);
    if (!found) return;
    selectedMarkId = id;
    pendingPos = { x: found.x, y: found.y };
    fillForm(markForm, found);
    reviewDraft.reviewer = "";
    reviewDraft.exitChecked = false;
    markFields.disabled = found.status === "invalid";
    render();
  }

  markForm.onsubmit = event => {
    event.preventDefault();
    const f = markForm.elements;
    const id = f.id.value;
    const found = id ? state.marks.find(m => m.id === id) : null;
    if (found && found.status === "invalid") {
      alert("该标记已随潜次改动失效，旧值仅留档，不能再编辑。");
      return;
    }
    const payload = {
      code: f.code.value.trim(),
      type: f.type.value,
      diveId: f.diveId.value,
      depth: f.depth.value.trim(),
      orientation: f.orientation.value.trim(),
      condition: f.condition.value.trim(),
      note: f.note.value.trim()
    };
    if (!payload.code || !payload.diveId) { alert("编号与所属潜次必填。"); return; }

    if (found) {
      if (R.markChanged(found, payload)) {
        Object.assign(found, R.toPending({ ...found, ...payload }));
      } else {
        Object.assign(found, payload);
      }
    } else {
      const pos = pendingPos || { x: 50, y: 50 };
      state.marks.push(Store.newMark(payload.code, payload.diveId, pos.x, pos.y));
      const created = state.marks[state.marks.length - 1];
      Object.assign(created, payload);
      selectedMarkId = created.id;
      pendingPos = null;
    }
    persist();
    render();
  };

  $("#deleteMarkBtn").onclick = () => {
    const id = markForm.elements.id.value;
    if (!id) return;
    if (!confirm("删除该标记？此操作不可撤销。")) return;
    state.marks = state.marks.filter(m => m.id !== id);
    selectedMarkId = null;
    pendingPos = null;
    markForm.reset();
    markFields.disabled = false;
    persist();
    render();
  };

  // —— 复核区（换人 + 核对实际出水时间）——
  function renderReview() {
    const mark = selectedMark();
    if (!mark) {
      reviewBox.className = "review";
      reviewBox.innerHTML = `<div class="muted">在地图或列表中选择标记：安全门槛不满足时只能“待复核”；复核须换人并核对实际出水时间。</div>`;
      return;
    }
    const dive = diveById(mark.diveId);

    if (mark.status === "approved") {
      reviewBox.className = "review approved";
      reviewBox.innerHTML =
        `<div class="rv-badge">✓ 已通过复核</div>` +
        `<div class="muted">复核人：${esc(mark.reviewedBy)} · ${fmtTime(mark.reviewedAt)}</div>` +
        `<div class="muted">实际出水：${dive ? fmtTime(dive.actualExit) : "潜次缺失"}</div>` +
        `<div class="muted">已计入潜次时间线与导出。</div>`;
      return;
    }
    if (mark.status === "invalid") {
      reviewBox.className = "review invalid";
      reviewBox.innerHTML =
        `<div class="rv-badge">✕ 已失效</div>` +
        `<div class="muted">关联潜次登记信息于 ${fmtTime(mark.invalidatedAt)} 被改动，标记立即失效。</div>` +
        `<div class="muted">旧值（编号 ${esc(mark.code)}）留档可查，但不再导出、不计入统计与时间线。</div>`;
      return;
    }

    // pending：实时显示阻塞原因
    const errors = R.reviewErrors(mark, dive, reviewDraft);
    reviewBox.className = "review pending";
    reviewBox.innerHTML =
      `<div class="rv-badge">待复核</div>` +
      `<label>复核人（不能是本次潜水员）</label>` +
      `<input id="reviewer" value="${esc(reviewDraft.reviewer)}" placeholder="填写复核人姓名">` +
      `<label class="checkline"><input type="checkbox" id="exitChecked"${reviewDraft.exitChecked ? " checked" : ""
      }> 已核对实际出水时间：${dive ? fmtTime(dive.actualExit) : "潜次缺失"}</label>` +
      `<ul class="blockers">${errors.map(e => `<li>${esc(e)}</li>`).join("")}</ul>` +
      `<button id="approveBtn" type="button">通过复核，计入时间线</button>`;

    // 只局部刷新阻塞列表与按钮，避免整体重建导致输入框失焦
    function refreshPending() {
      const errs = R.reviewErrors(mark, dive, reviewDraft);
      reviewBox.querySelector(".blockers").innerHTML =
        errs.map(e => `<li>${esc(e)}</li>`).join("");
      reviewBox.querySelector("#approveBtn").disabled = errs.length > 0;
    }
    $("#reviewer").oninput = e => { reviewDraft.reviewer = e.target.value; refreshPending(); };
    $("#exitChecked").onchange = e => { reviewDraft.exitChecked = e.target.checked; refreshPending(); };
    refreshPending();
    $("#approveBtn").onclick = () => {
      const errs = R.reviewErrors(mark, dive, reviewDraft);
      if (errs.length) { alert("暂不能通过复核：\n· " + errs.join("\n· ")); return; }
      mark.status = "approved";
      mark.reviewedBy = reviewDraft.reviewer.trim();
      mark.reviewedAt = new Date().toISOString();
      reviewDraft.reviewer = "";
      reviewDraft.exitChecked = false;
      persist();
      render();
    };
  }

  // —— 列表 / 时间线 ——
  function renderList(data) {
    listTitle.textContent = "标记列表";
    list.className = "list";
    if (!data.length) {
      list.innerHTML = `<div class="muted">当前筛选下没有标记。</div>`;
      return;
    }
    list.innerHTML = data.map(m => {
      const d = diveById(m.diveId);
      return `<div class="item st-${m.status} ${m.id === selectedMarkId ? "active" : ""}" data-id="${m.id}">
        <b>${esc(m.code)}</b>
        <span class="pill">${typeNames[m.type]}</span>
        <span class="pill p-${m.status}">${statusNames[m.status]}</span>
        <div class="muted">${esc(d ? d.code : "未关联潜次")} · ${esc(m.depth || "深度未填")} · ${esc(m.orientation || "朝向未填")}</div>
        ${m.status === "invalid" ? `<div class="muted">已失效：潜次改动，旧值留档不导出</div>` : `<div>${esc(m.condition || "")}</div>`}
      </div>`;
    }).join("");
    list.querySelectorAll("[data-id]").forEach(el => {
      el.onclick = () => editMark(el.dataset.id);
    });
  }

  function renderTimeline() {
    // 只有复核通过的标记才计入时间线
    const data = filteredMarks().filter(m => m.status === "approved");
    listTitle.textContent = "潜次时间线（仅复核通过）";
    list.className = "timeline";
    if (!data.length) {
      list.innerHTML = `<div class="muted">当前筛选下没有已通过复核的标记；待复核与已失效标记不计入时间线。</div>`;
      return;
    }
    const groups = {};
    data.forEach(m => { (groups[m.diveId] ||= []).push(m); });
    const ordered = Object.keys(groups)
      .map(id => ({ dive: diveById(id), items: groups[id] }))
      .sort((a, b) => String(a.dive?.plannedStart || "").localeCompare(String(b.dive?.plannedStart || "")));

    list.innerHTML = ordered.map(g => {
      const d = g.dive;
      return `<div class="item">
        <b>${esc(d ? d.code : "未关联潜次")}${d && d.closed ? " · 已闭潜" : ""}</b>
        <div class="muted">计划 ${fmtTime(d && d.plannedStart)} – ${fmtTime(d && d.plannedEnd)} ｜ 实际出水 ${fmtTime(d && d.actualExit)}</div>
        <div class="muted">潜水员：${d ? esc(R.buddies(d).join("、")) : "—"} ｜ 余压 ${d ? esc(d.endPressure) : "—"} 巴</div>
        ${g.items.map(i => `<div>${esc(i.code)} · ${typeNames[i.type]} · ${esc(i.depth || "")} <span class="muted">（复核：${esc(i.reviewedBy)}）</span></div>`).join("")}
      </div>`;
    }).join("");
  }

  // —— 统计（与筛选共用同一份数据）——
  function renderStats() {
    const ms = R.markStats(filteredMarks());
    const ds = R.diveStats(state.dives);
    const tiles = [
      ["标记总数", ms.total],
      ["待复核", ms.pending],
      ["复核通过", ms.approved],
      ["已失效", ms.invalid],
      ["已闭潜潜次", `${ds.closed}/${ds.total}`]
    ];
    stats.innerHTML = tiles.map(([label, value]) =>
      `<div class="tile"><b>${value}</b><span>${label}</span></div>`).join("");
  }

  // —— 筛选 / 视图（与刷新一致：选择写入存储）——
  filterType.value = prefs.filterType || "";
  filterStatus.value = prefs.filterStatus || "";
  view.value = prefs.view || "list";
  [filterType, filterStatus, view].forEach(el => {
    el.onchange = () => {
      prefs.filterType = filterType.value;
      prefs.filterStatus = filterStatus.value;
      prefs.view = view.value;
      savePrefs();
      render();
    };
  });

  // —— 导出（旧值与已失效标记不导出）——
  $("#exportBtn").onclick = () => {
    const payload = R.buildExport(state);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "dive-log.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // —— 初始化 ——
  if (prefs.diveId && state.dives.some(d => d.id === prefs.diveId)) {
    diveSelect.value = prefs.diveId;
    loadDiveIntoForm(diveById(prefs.diveId));
  } else if (state.dives.length) {
    diveSelect.value = state.dives[0].id;
    loadDiveIntoForm(state.dives[0]);
  } else {
    renderGate();
  }
  markFields.disabled = false;
  render();
})();
