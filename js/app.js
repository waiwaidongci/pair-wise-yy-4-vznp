/*
 * 界面层：只负责读取输入、调用规则层动作、经存储层持久化并刷新渲染。
 * 本文件不包含任何安全阈值与状态流转判定，全部以 DiveRules 的结果为准。
 */
(function () {
  "use strict";

  var R = window.DiveRules;
  var Store = window.DiveStore;

  // —— 全局状态（唯一数据源：从存储层载入，任何变更都先经规则层再写回）——
  var state = Store.load();
  var prefs = Store.loadPrefs();
  var pendingPos = null; // 地图点击产生的待保存坐标

  var $ = function (sel) { return document.querySelector(sel); };

  var typeNames = { ceramic: "陶片", wood: "木构件", metal: "金属件", unknown: "未知物" };
  var statusMeta = {
    pending: { cls: "warn", name: "待复核" },
    approved: { cls: "ok", name: "已计入时间线" },
    invalidated: { cls: "bad", name: "已失效" }
  };

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function fmtTime(value) {
    if (!value) return "—";
    var d = new Date(value);
    if (isNaN(d.getTime())) return esc(value);
    function p(n) { return String(n).padStart(2, "0"); }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function persist(nextState) {
    state = nextState;
    Store.save(state);
    render();
  }

  var bannerTimer = null;
  function banner(text, kind) {
    var el = $("#banner");
    el.textContent = text;
    el.className = "show " + (kind || "info");
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(function () { el.className = ""; }, 7000);
  }

  function currentFilter() {
    var f = {};
    if ($("#filterType").value) f.type = $("#filterType").value;
    if ($("#filterStatus").value) f.status = $("#filterStatus").value;
    if ($("#filterDive").value) f.diveId = $("#filterDive").value;
    return f;
  }

  function diveById(id) {
    return state.dives.find(function (d) { return d.id === id; }) || null;
  }
  function markById(id) {
    return state.marks.find(function (m) { return m.id === id; }) || null;
  }

  // 肋骨装饰
  for (var i = 0; i < 7; i++) {
    var rib = document.createElement("div");
    rib.className = "rib";
    rib.style.left = (28 + i * 7) + "%";
    $("#map").appendChild(rib);
  }

  // ============ 渲染 ============
  function render() {
    renderMap();
    renderStats();
    renderMarkList();
    renderDiveList();
    renderTimeline();
    renderArchive();
    renderDiveOptions();
    syncViewPanels();
    // 表单中打开的标记若状态已变（如复核通过），同步刷新其复核面板
    var openId = $("#markForm").id.value;
    var openMark = openId ? markById(openId) : null;
    if (openMark) {
      $("#deleteBtn").disabled = openMark.status === "invalidated";
      renderReviewBox(openMark);
    }
  }

  function renderMap() {
    $("#map").querySelectorAll(".marker").forEach(function (el) { el.remove(); });
    R.filterMarks(state.marks, currentFilter()).forEach(function (m) {
      var el = document.createElement("button");
      el.type = "button";
      el.className = "marker " + m.type + " st-" + m.status +
        (m.id === $("#markForm").id.value ? " selected" : "");
      el.style.left = m.x + "%";
      el.style.top = m.y + "%";
      el.textContent = (m.code || "?").slice(0, 2);
      el.title = m.code + " · " + typeNames[m.type] + " · " + statusMeta[m.status].name;
      if (m.status !== "invalidated") el.onclick = function (ev) { ev.stopPropagation(); selectMark(m.id); };
      $("#map").appendChild(el);
    });
  }

  function renderStats() {
    var s = R.computeStats(state.marks, state.dives, currentFilter());
    var boxes = [
      [s.total, "标记（当前筛选）"],
      [s.approved, "已计入时间线"],
      [s.pendingReview, "待复核"],
      [s.invalidated, "已失效留档"],
      [s.dives, "潜次 / 未闭潜 " + s.openDives]
    ];
    $("#stats").innerHTML = boxes.map(function (b) {
      return '<div class="stat"><b>' + b[0] + '</b><span>' + esc(b[1]) + '</span></div>';
    }).join("");
  }

  function statusPill(status) {
    var meta = statusMeta[status] || { cls: "gray", name: status };
    return '<span class="pill ' + meta.cls + '">' + esc(meta.name) + '</span>';
  }

  function renderMarkList() {
    var data = R.filterMarks(state.marks, currentFilter());
    $("#listTitle").textContent = "标记列表（" + data.length + "）";
    if (!data.length) {
      $("#markList").innerHTML = '<div class="muted">无匹配标记。点击平面图或先保存一个新位置。</div>';
      return;
    }
    $("#markList").innerHTML = data.map(function (m) {
      var d = diveById(m.diveId);
      return '<div class="item ' + (m.status === "invalidated" ? "invalid" : "") +
        (m.id === $("#markForm").id.value ? " active" : "") + '" data-mark="' + m.id + '">' +
        '<b>' + esc(m.code) + '</b> ' +
        '<span class="pill gray">' + esc(typeNames[m.type] || m.type) + '</span>' +
        statusPill(m.status) +
        '<div class="muted">' + esc(d ? d.code : "(潜次已删除)") + " · " + esc(m.depth) + " · " + esc(m.orientation || "—") + '</div>' +
        (m.status === "invalidated" ? '<div class="muted">潜次改动后失效，旧值见「留档」</div>' : '<div>' + esc(m.condition || "") + '</div>') +
        '</div>';
    }).join("");
    $("#markList").querySelectorAll("[data-mark]").forEach(function (el) {
      el.onclick = function () { selectMark(el.dataset.mark); };
    });
  }

  function renderDiveOptions() {
    var keepMark = $("#markDive").value;
    $("#markDive").innerHTML = state.dives.map(function (d) {
      var label = d.code + "（" + (d.status === R.DIVE_CLOSED_PENDING ? "已闭潜·待复核" : "未闭潜") +
        "，修订 v" + d.revision + "）";
      return '<option value="' + d.id + '">' + esc(label) + '</option>';
    }).join("");
    if (keepMark && state.dives.some(function (d) { return d.id === keepMark; })) {
      $("#markDive").value = keepMark;
    }
    var keepFilter = $("#filterDive").value;
    $("#filterDive").innerHTML = '<option value="">全部潜次</option>' + state.dives.map(function (d) {
      return '<option value="' + d.id + '">' + esc(d.code) + '</option>';
    }).join("");
    if (keepFilter && state.dives.some(function (d) { return d.id === keepFilter; })) {
      $("#filterDive").value = keepFilter;
    }
  }

  // 闭潜区块：安全闸门不通过时只能停留在待复核前置态
  function closureBlock(d) {
    var safety = R.safetyViolations(d);
    var lines = [
      '<div class="' + (safety.some(function (e) { return e.indexOf("潜伴") >= 0; }) ? "fail" : "pass") +
        '">潜伴：' + R.buddyNames(d).length + '/2 人（' + esc(R.buddyNames(d).join("、") || "未填") + '）</div>',
      '<div class="' + (safety.some(function (e) { return e.indexOf("余压") >= 0; }) ? "fail" : "pass") +
        '">起返压：' + esc(d.returnPressureBar) + ' 巴（安全余压 ≥ ' + R.MIN_RETURN_PRESSURE_BAR + ' 巴）</div>',
      '<div class="' + (safety.some(function (e) { return e.indexOf("潮高") >= 0; }) ? "fail" : "pass") +
        '">潮高：' + esc(d.tideHeightM) + ' 米（窗口期 ≤ ' + R.MAX_TIDE_HEIGHT_M + ' 米）</div>'
    ];
    if (d.status === R.DIVE_CLOSED_PENDING) {
      return '<div class="gate">' + lines.join("") +
        '<div class="muted">已闭潜，实际出水 ' + esc(fmtTime(d.actualExit)) +
        '；标记仍须第三人复核。</div></div>';
    }
    var disabledAttr = safety.length ? "disabled" : "";
    return '<div class="gate">' + lines.join("") + "</div>" +
      (safety.length ? '<div class="muted" style="margin-bottom:6px">安全闸门未通过：' +
        safety.map(esc).join("；") + "，不得闭潜。</div>" :
        '<div class="muted" style="margin-bottom:6px">安全闸门已通过，核对实际出水时间后闭潜。</div>') +
      '<div class="close-row"><div><label>实际出水时间 *</label>' +
      '<input type="datetime-local" data-exit="' + d.id + '" value="' + esc(d.actualExit || "") + '"></div>' +
      '<button data-close="' + d.id + '" ' + disabledAttr + '>闭潜并送复核</button></div>';
  }

  function renderDiveList() {
    if (!state.dives.length) {
      $("#diveList").innerHTML = '<div class="muted">尚无潜次，先在上方登记。</div>';
      return;
    }
    $("#diveList").innerHTML = state.dives.map(function (d) {
      var linked = state.marks.filter(function (m) { return m.diveId === d.id; });
      var counts = {
        pending: linked.filter(function (m) { return m.status === "pending"; }).length,
        approved: linked.filter(function (m) { return m.status === "approved"; }).length,
        invalidated: linked.filter(function (m) { return m.status === "invalidated"; }).length
      };
      var statePill = d.status === R.DIVE_CLOSED_PENDING
        ? '<span class="pill warn">已闭潜·标记待复核</span>'
        : '<span class="pill gray">未闭潜</span>';
      return '<div class="item"><b>' + esc(d.code) + '</b> ' + statePill +
        ' <span class="pill gray">v' + d.revision + "</span>" +
        '<div class="muted">主潜员 ' + esc(d.leader) + " · 潜伴 " + esc(R.buddyNames(d).join("、")) + "</div>" +
        '<div class="muted">' + esc(fmtTime(d.plannedStart)) + " → " + esc(fmtTime(d.plannedEnd)) +
        " · 潮高 " + esc(d.tideHeightM) + "m · 起返压 " + esc(d.returnPressureBar) + " 巴</div>" +
        '<div class="muted">标记：已计入 ' + counts.approved + " · 待复核 " + counts.pending +
        " · 已失效 " + counts.invalidated + "</div>" +
        closureBlock(d) +
        '<div class="actions"><button type="button" class="ghost" data-edit-dive="' + d.id + '">改动潜次</button></div>' +
        "</div>";
    }).join("");

    $("#diveList").querySelectorAll("[data-close]").forEach(function (btn) {
      btn.onclick = function () {
        var id = btn.dataset.close;
        var exitInput = $("#diveList").querySelector('[data-exit="' + id + '"]');
        var res = R.closeDive(state, id, exitInput.value);
        if (!res.ok) { banner("无法闭潜：\n" + res.errors.join("\n"), "error"); return; }
        persist(res.state);
        banner("潜次已闭潜，关联标记进入待复核；请由第三人核对实际出水时间后复核。", "info");
      };
    });
    $("#diveList").querySelectorAll("[data-edit-dive]").forEach(function (btn) {
      btn.onclick = function () { editDive(btn.dataset.editDive); };
    });
  }

  function renderTimeline() {
    var groups = R.buildTimeline(state.marks, state.dives, currentFilter());
    if (!groups.length) {
      $("#timeline").innerHTML = '<div class="muted">当前筛选下没有复核通过的标记，时间线为空。</div>';
      return;
    }
    $("#timeline").innerHTML = groups.map(function (g) {
      var d = g.dive;
      return '<div class="item"><b>' + esc(g.diveCode) + '</b> ' +
        '<span class="pill ok">已复核 ' + g.items.length + " 个标记</span>" +
        '<div class="muted">计划 ' + esc(fmtTime(g.plannedStart)) + " → " +
        esc(fmtTime(d ? d.plannedEnd : "")) + " · 实际出水 " + esc(fmtTime(d ? d.actualExit : null)) +
        " · 复核人 " + esc(g.items[0].reviewedBy) + "</div>" +
        g.items.map(function (m) {
          return '<div>· ' + esc(m.code) + "（" + esc(typeNames[m.type] || m.type) + "）" +
            " " + esc(m.depth) + " " + esc(m.orientation || "") + "</div>";
        }).join("") + "</div>";
    }).join("");
  }

  function renderArchive() {
    if (!state.archive.length) {
      $("#archive").innerHTML = '<div class="muted">暂无失效留档。</div>';
      return;
    }
    var rows = state.archive.slice().reverse();
    $("#archive").innerHTML = rows.map(function (a) {
      return '<div class="item invalid"><b>' + esc(a.markCode) + "</b> " +
        '<span class="pill bad">潜次改动失效</span>' +
        '<div class="muted">' + esc(fmtTime(a.at)) + " · 原属潜次 " + esc(a.diveCode) + "</div>" +
        '<div class="muted">旧计划：' + esc(fmtTime(a.oldDive.plannedStart)) + " → " +
        esc(fmtTime(a.oldDive.plannedEnd)) + " · 潮高 " + esc(a.oldDive.tideHeightM) +
        "m · 起返压 " + esc(a.oldDive.returnPressureBar) + " 巴</div>" +
        '<div class="muted">旧位置：' + esc(a.oldMark.x) + "%, " + esc(a.oldMark.y) +
        "% · 深度 " + esc(a.oldMark.depth) + "</div>" +
        '<div class="muted">留档编号 ' + esc(a.id) + "（不导出）</div></div>";
    }).join("");
  }

  // 表单下方实时安全闸门（登记/改动时给提示，但判定以 closeDive 为准）
  function renderLiveGate() {
    var form = $("#diveForm");
    var draft = readDiveForm();
    var safety = R.safetyViolations(R.normalizeDraft(draft));
    var gate = $("#gate");
    var rows = [];
    function line(label, ok, detail) {
      rows.push('<div class="' + (ok ? "pass" : "fail") + '">' + label + "：" + detail + "</div>");
    }
    var buddies = R.buddyNames(R.normalizeDraft(draft));
    line("潜伴", buddies.length >= 2, buddies.length + "/2 人（" + esc(buddies.join("、") || "未填") + "）");
    var p = draft.returnPressureBar === "" ? NaN : Number(draft.returnPressureBar);
    line("起返压", !isNaN(p) && p >= 50, (isNaN(p) ? "未填" : p) + " 巴");
    var t = draft.tideHeightM === "" ? NaN : Number(draft.tideHeightM);
    line("潮高", !isNaN(t) && t <= 0.8, (isNaN(t) ? "未填" : t) + " 米");
    gate.innerHTML = rows.join("") +
      (safety.length ? '<div class="fail">当前条件不得闭潜；登记/保存后需先纠正才能闭潜。</div>'
        : '<div class="pass">安全条件满足，保存后可闭潜。</div>');
  }

  function syncViewPanels() {
    var v = $("#view").value;
    $("#viewMarks").hidden = v !== "marks";
    $("#viewDives").hidden = v !== "dives";
    $("#viewTimeline").hidden = v !== "timeline";
    $("#viewArchive").hidden = v !== "archive";
  }

  // ============ 标记表单 ============
  function resetMarkForm() {
    var form = $("#markForm");
    form.reset();
    form.id.value = "";
    form.x.value = pendingPos ? pendingPos.x : "";
    form.y.value = pendingPos ? pendingPos.y : "";
    form.code.value = "M-" + String(state.marks.length + 1).padStart(3, "0");
    if (state.dives.length) form.diveId.value = state.dives[0].id;
    $("#reviewBox").innerHTML = "";
    $("#deleteBtn").disabled = true;
    render();
  }

  function selectMark(id) {
    var m = markById(id);
    if (!m) return;
    pendingPos = { x: m.x, y: m.y };
    var form = $("#markForm");
    form.reset();
    ["id", "code", "type", "diveId", "x", "y", "depth", "orientation", "condition", "note"]
      .forEach(function (key) { if (form[key]) form[key].value = m[key] == null ? "" : m[key]; });
    $("#deleteBtn").disabled = false;
    renderReviewBox(m);
    $("#view").value = "marks";
    Store.savePrefs(Object.assign(prefs, { view: "marks" }));
    render();
  }

  function renderReviewBox(m) {
    var box = $("#reviewBox");
    var d = diveById(m.diveId);
    if (m.status === "invalidated") {
      box.innerHTML = '<div class="review-box"><b>标记已失效</b>' +
        '<div class="muted">关联潜次在 ' + esc(fmtTime(m.invalidatedAt)) + " 被改动，" +
        '本标记旧值留档但不再导出，也不能补复核。需在修订后的潜次下重新登记标记。</div></div>';
      return;
    }
    var safety = d ? R.safetyViolations(d) : ["关联潜次不存在"];
    var closed = d && d.status === R.DIVE_CLOSED_PENDING;
    var why = [];
    if (!closed) why.push("潜次尚未闭潜");
    if (safety.length) why = why.concat(safety);
    if (m.status === "approved") {
      box.innerHTML = '<div class="review-box"><b>已通过换人复核</b>' +
        '<div class="muted">复核人：' + esc(m.reviewedBy) + " · 复核时间 " + esc(fmtTime(m.reviewedAt)) +
        " · 核对出水 " + esc(fmtTime(m.reviewExit)) + "</div>" +
        '<div class="muted">再次编辑本标记会撤销复核结论，需重新换人复核。</div></div>';
      return;
    }
    box.innerHTML = '<form class="review-box" id="reviewForm">' +
      "<b>待复核</b>" +
      (why.length ? '<div class="muted" style="color:#8a3418">' + why.map(esc).join("；") + "</div>" : "") +
      '<label>复核人（必须是本潜次主潜员与两名潜伴之外的第三人）*</label>' +
      '<input name="reviewer" placeholder="例如：许复核" required>' +
      '<label>核对实际出水时间 *（须与闭潜记录一致）</label>' +
      '<input name="exit" type="datetime-local" value="' + esc(d && d.actualExit || "") + '" required>' +
      '<div class="actions"><button ' + ((!closed || safety.length) ? "disabled" : "") +
      ">换人复核通过</button></div></form>";
    var rf = $("#reviewForm");
    if (rf) rf.onsubmit = function (ev) {
      ev.preventDefault();
      var data = Object.fromEntries(new FormData(rf).entries());
      var res = R.approveMark(state, m.id, data.reviewer, data.exit);
      if (!res.ok) { banner("复核未通过：\n" + res.errors.join("\n"), "error"); return; }
      persist(res.state);
      banner("复核通过：标记 " + m.code + " 已计入潜次时间线。", "info");
    };
  }

  $("#map").addEventListener("click", function (event) {
    if (event.target.closest(".marker")) return;
    var rect = $("#map").getBoundingClientRect();
    pendingPos = {
      x: Number(((event.clientX - rect.left) / rect.width * 100).toFixed(2)),
      y: Number(((event.clientY - rect.top) / rect.height * 100).toFixed(2))
    };
    $("#view").value = "marks";
    Store.savePrefs(Object.assign(prefs, { view: "marks" }));
    syncViewPanels();
    resetMarkForm();
  });

  $("#markForm").onsubmit = function (event) {
    event.preventDefault();
    var form = event.target;
    var data = Object.fromEntries(new FormData(form).entries());
    if (!data.x || !data.y) {
      if (!pendingPos) pendingPos = { x: 50, y: 50 };
      data.x = pendingPos.x; data.y = pendingPos.y;
    }
    var res = R.upsertMark(state, data);
    if (!res.ok) { banner("标记未保存：\n" + res.errors.join("\n"), "error"); return; }
    var createdId = res.mark.id;
    persist(res.state);
    pendingPos = null;
    selectMark(createdId);
    banner(res.resetApproval
      ? "标记已更新；因内容变动，原复核结论撤销，需重新换人复核。"
      : "标记已保存为待复核；潜次闭潜后由第三人复核通过才计入时间线。", "info");
  };

  $("#deleteBtn").onclick = function () {
    var id = $("#markForm").id.value;
    if (!id) return;
    var m = markById(id);
    if (!window.confirm("删除标记 " + (m ? m.code : "") + "？此操作不可恢复。")) return;
    persist(R.deleteMark(state, id).state);
    pendingPos = null;
    resetMarkForm();
    banner("标记已删除。", "info");
  };

  $("#markCancelBtn").onclick = function () { pendingPos = null; resetMarkForm(); };

  // ============ 潜次表单 ============
  function readDiveForm() {
    var f = $("#diveForm");
    var data = Object.fromEntries(new FormData(f).entries());
    return R.normalizeDraft(data);
  }

  function fillDiveForm(d) {
    var f = $("#diveForm");
    f.reset();
    f.id.value = d.id;
    f.code.value = d.code;
    f.leader.value = d.leader;
    f.buddies.value = (d.buddies || []).join("、");
    f.plannedStart.value = d.plannedStart || "";
    f.plannedEnd.value = d.plannedEnd || "";
    f.tideHeightM.value = d.tideHeightM === "" || d.tideHeightM == null ? "" : d.tideHeightM;
    f.returnPressureBar.value = d.returnPressureBar === "" || d.returnPressureBar == null ? "" : d.returnPressureBar;
    $("#diveFormTitle").textContent = "改动潜次 " + d.code + "（修订 v" + d.revision + "）";
    $("#diveSaveBtn").textContent = "保存改动（关联标记将立即失效）";
    $("#diveEditHint").hidden = false;
    renderLiveGate();
  }

  function resetDiveForm() {
    var f = $("#diveForm");
    f.reset();
    f.id.value = "";
    $("#diveFormTitle").textContent = "潜次登记";
    $("#diveSaveBtn").textContent = "登记潜次";
    $("#diveEditHint").hidden = true;
    renderLiveGate();
  }

  function editDive(id) {
    var d = diveById(id);
    if (!d) return;
    $("#view").value = "dives";
    Store.savePrefs(Object.assign(prefs, { view: "dives" }));
    syncViewPanels();
    fillDiveForm(d);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  $("#diveForm").addEventListener("input", renderLiveGate);

  $("#diveForm").onsubmit = function (event) {
    event.preventDefault();
    var data = readDiveForm();
    var id = $("#diveForm").id.value;
    var res;
    if (id) {
      res = R.reviseDive(state, id, data);
      if (!res.ok) { banner("改动未保存：\n" + res.errors.join("\n"), "error"); return; }
      persist(res.state);
      if (res.unchanged) {
        banner("字段无变化，潜次未修订。", "info");
      } else {
        banner("潜次已修订（v" + res.dive.revision + "），" + res.invalidated +
          " 个关联标记立即失效：旧值已留档、不再导出，须重新闭潜与复核。", "error");
      }
    } else {
      res = R.registerDive(state, data);
      if (!res.ok) { banner("登记失败：\n" + res.errors.join("\n"), "error"); return; }
      persist(res.state);
      var safety = R.safetyViolations(res.dive);
      banner("潜次 " + res.dive.code + " 已登记。" +
        (safety.length ? "但安全闸门未通过（" + safety.join("；") + "），纠正前不得闭潜。"
          : "安全条件满足，可在潜次列表闭潜。"), safety.length ? "error" : "info");
    }
    resetDiveForm();
  };

  $("#diveCancelBtn").onclick = resetDiveForm;

  // ============ 筛选 / 视图 / 刷新 / 导出 ============
  ["filterType", "filterStatus", "filterDive"].forEach(function (id) {
    $("#" + id).addEventListener("change", function () {
      Store.savePrefs(Object.assign(prefs, {
        filterType: $("#filterType").value,
        filterStatus: $("#filterStatus").value,
        filterDive: $("#filterDive").value
      }));
      render();
    });
  });

  $("#view").addEventListener("change", function () {
    Store.savePrefs(Object.assign(prefs, { view: $("#view").value }));
    syncViewPanels();
  });

  $("#refreshBtn").onclick = function () {
    state = Store.load();
    render();
    banner("已从本地存储重新载入；筛选条件与视图保持不变，统计、时间线与地图已同步刷新。", "info");
  };

  $("#resetBtn").onclick = function () {
    if (!window.confirm("清除本地潜水数据并恢复为内置示例？")) return;
    localStorage.removeItem(Store.STATE_KEY);
    state = Store.load();
    render();
    banner("已恢复示例数据。", "info");
  };

  $("#exportBtn").onclick = function () {
    var json = Store.exportJson(state, currentFilter());
    var blob = new Blob([json], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "dive-records-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
    var count = JSON.parse(json).marks.length;
    banner("已导出 " + count + " 个未失效标记（失效留档不导出，筛选条件一并写入 JSON）。", "info");
  };

  // —— 启动：恢复筛选/视图偏好，保证刷新前后一致 ——
  if (prefs.filterType) $("#filterType").value = prefs.filterType;
  if (prefs.filterStatus) $("#filterStatus").value = prefs.filterStatus;
  if (prefs.view) $("#view").value = prefs.view;
  renderDiveOptions();
  if (prefs.filterDive && state.dives.some(function (d) { return d.id === prefs.filterDive; })) {
    $("#filterDive").value = prefs.filterDive;
  }
  resetMarkForm();
  resetDiveForm();
  syncViewPanels();
  render();
})();
