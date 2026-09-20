/*
 * 规则层：潮汐窗口与安全余压闭环的全部业务规则。
 * 纯函数实现，不依赖 DOM / localStorage，可在 Node 中直接测试。
 * 存储层与界面层只能通过本文件导出的函数读写状态。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DiveRules = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // —— 硬性安全阈值（闭潜闸门）——
  var MAX_TIDE_HEIGHT_M = 0.8;   // 潮高 > 0.8m 不得闭潜
  var MIN_BUDDY_COUNT = 2;       // 潜伴不足两人不得闭潜
  var MIN_RETURN_PRESSURE_BAR = 50; // 起返（余）压低于 50 巴不得闭潜

  // —— 状态枚举 ——
  var DIVE_OPEN = "open";                 // 已登记，未闭潜
  var DIVE_CLOSED_PENDING = "closed";     // 已闭潜，标记待复核
  var MARK_PENDING = "pending";           // 待复核
  var MARK_APPROVED = "approved";         // 复核通过（计入时间线）
  var MARK_INVALIDATED = "invalidated";   // 潜次被改动而失效（留档不导出）

  // —— 小工具 ——
  function uuid() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  // 同一潜次只记录两名不同潜水员，重复/空白输入去重
  function buddyNames(dive) {
    var names = [];
    (dive.buddies || []).forEach(function (name) {
      name = String(name || "").trim();
      if (name && names.indexOf(name) === -1) names.push(name);
    });
    return names;
  }

  function diverOf(dive) {
    return String(dive && dive.leader ? dive.leader : "").trim();
  }

  function parseTime(value) {
    if (!value) return null;
    var t = new Date(value).getTime();
    return isNaN(t) ? null : t;
  }

  // —— 规则 R1：登记校验（计划时段 / 两名潜水员 / 起返压字段）——
  function draftViolations(dive) {
    var errors = [];
    if (!parseTime(dive.plannedStart)) errors.push("缺少计划开始时间");
    if (!parseTime(dive.plannedEnd)) errors.push("缺少计划结束时间");
    if (parseTime(dive.plannedStart) && parseTime(dive.plannedEnd) &&
        parseTime(dive.plannedEnd) <= parseTime(dive.plannedStart)) {
      errors.push("计划结束时间必须晚于开始时间");
    }
    if (!diverOf(dive)) errors.push("缺少主潜员");
    var buddies = buddyNames(dive);
    if (buddies.length < MIN_BUDDY_COUNT) {
      errors.push("潜伴不足两人（当前" + buddies.length + "人）");
    }
    var p = Number(dive.returnPressureBar);
    if (dive.returnPressureBar === "" || dive.returnPressureBar === undefined ||
        dive.returnPressureBar === null || isNaN(p)) {
      errors.push("缺少起返压");
    } else if (p < 0) {
      errors.push("起返压不能为负值");
    }
    var tide = Number(dive.tideHeightM);
    if (dive.tideHeightM === "" || dive.tideHeightM === undefined ||
        dive.tideHeightM === null || isNaN(tide)) {
      errors.push("缺少潮高");
    }
    if (!String(dive.code || "").trim()) errors.push("缺少潜次编号");
    return errors;
  }

  // —— 规则 R2：闭潜安全闸门（三条硬性安全规则）——
  function safetyViolations(dive) {
    var errors = [];
    var buddies = buddyNames(dive);
    if (buddies.length < MIN_BUDDY_COUNT) {
      errors.push("潜伴不足两人（" + buddies.length + "/2）");
    }
    var p = Number(dive.returnPressureBar);
    if (isNaN(p) || p < MIN_RETURN_PRESSURE_BAR) {
      errors.push("余压 " + (isNaN(p) ? "未知" : p) + " 巴低于安全余压 " + MIN_RETURN_PRESSURE_BAR + " 巴");
    }
    var tide = Number(dive.tideHeightM);
    if (isNaN(tide) || tide > MAX_TIDE_HEIGHT_M) {
      errors.push("潮高 " + (isNaN(tide) ? "未知" : tide) + " 米超过窗口期 " + MAX_TIDE_HEIGHT_M + " 米");
    }
    return errors;
  }

  // —— 规则 R3：闭潜校验（字段完整性 + 实际出水时间 + 安全闸门）——
  function closureViolations(dive) {
    var errors = draftViolations(dive);
    var exit = parseTime(dive.actualExit);
    if (!exit) {
      errors.push("缺少实际出水时间");
    } else if (parseTime(dive.plannedEnd) && exit > parseTime(dive.plannedEnd)) {
      errors.push("实际出水时间晚于计划结束时间");
    } else if (parseTime(dive.plannedStart) && exit < parseTime(dive.plannedStart)) {
      errors.push("实际出水时间早于计划开始时间");
    }
    return errors.concat(safetyViolations(dive));
  }

  // —— 规则 R4：换人复核 ——
  // 复核人必须是与该潜次无关的第三人（不是主潜员，也不是任一潜伴），
  // 并须再次核对实际出水时间。
  function reviewViolations(mark, dive, reviewer, exitTime) {
    var errors = [];
    if (!mark) return ["标记不存在"];
    if (!dive) return ["关联潜次不存在"];
    if (dive.status !== DIVE_CLOSED_PENDING) {
      errors.push("潜次尚未闭潜，无法复核");
    }
    var safety = safetyViolations(dive);
    if (safety.length) errors = errors.concat(safety);
    var reviewerName = String(reviewer || "").trim();
    if (!reviewerName) {
      errors.push("缺少复核人");
    } else {
      var involved = [diverOf(dive)].concat(buddyNames(dive));
      if (involved.indexOf(reviewerName) !== -1) {
        errors.push("复核须换人：复核人不能是本潜次潜水员（" + involved.join("、") + "）");
      }
    }
    var exit = parseTime(exitTime);
    if (!exit) {
      errors.push("须核对并填写实际出水时间");
    } else {
      if (!parseTime(dive.actualExit)) {
        errors.push("闭潜记录缺少实际出水时间");
      } else if (exit !== parseTime(dive.actualExit)) {
        errors.push("复核出水时间与闭潜记录不一致");
      }
    }
    return errors;
  }

  function canApprove(mark, dive, reviewer, exitTime) {
    return reviewViolations(mark, dive, reviewer, exitTime).length === 0;
  }

  // —— 数据校验辅助 ——
  function markViolations(mark, dives, existingMarks) {
    var errors = [];
    if (!String(mark.code || "").trim()) errors.push("缺少编号");
    if (!mark.type) errors.push("缺少类型");
    if (!mark.diveId) errors.push("缺少关联潜次");
    var dive = (dives || []).find(function (d) { return d.id === mark.diveId; });
    if (mark.diveId && !dive) errors.push("关联潜次不存在");
    if (String(mark.depth === undefined || mark.depth === "" ? "" : mark.depth).trim() === "" &&
        mark.depth !== 0 && mark.depth !== "0") {
      errors.push("缺少深度");
    }
    if (existingMarks) {
      var dup = existingMarks.find(function (m) {
        return m.id !== mark.id && String(m.code).trim() === String(mark.code || "").trim();
      });
      if (dup) errors.push("编号与已有标记重复");
    }
    return errors;
  }

  var DIVE_FIELDS = ["code", "leader", "buddies", "plannedStart", "plannedEnd",
    "tideHeightM", "returnPressureBar"];

  function normalizeDraft(input) {
    return {
      code: String(input.code || "").trim(),
      leader: String(input.leader || "").trim(),
      buddies: Array.isArray(input.buddies)
        ? input.buddies.map(function (b) { return String(b || "").trim(); }).filter(Boolean)
        : String(input.buddies || "").split(/[,，、\s]+/).map(function (s) { return s.trim(); }).filter(Boolean),
      plannedStart: input.plannedStart || "",
      plannedEnd: input.plannedEnd || "",
      tideHeightM: input.tideHeightM === "" || input.tideHeightM === undefined ? "" : Number(input.tideHeightM),
      returnPressureBar: input.returnPressureBar === "" || input.returnPressureBar === undefined ? "" : Number(input.returnPressureBar)
    };
  }

  // —— 状态变更操作（不可变语义：均基于传入 state 返回新 state）——

  // 登记潜次（或在无字段变化时更新登记字段；通过闭潜闸门也保持 open，
  // 闭潜必须显式调用 closeDive）
  function registerDive(state, input) {
    var draft = normalizeDraft(input);
    var errors = draftViolations(draft);
    var dup = state.dives.find(function (d) {
      return d.id !== input.id && d.code.trim() === draft.code;
    });
    if (dup) errors.push("潜次编号与已有潜次重复");
    if (errors.length) return { ok: false, errors: errors, state: state };

    if (input.id) {
      var current = state.dives.find(function (d) { return d.id === input.id; });
      if (!current) return { ok: false, errors: ["潜次不存在"], state: state };
      return reviseDive(state, input.id, draft);
    }
    var dive = {
      id: uuid(),
      code: draft.code,
      leader: draft.leader,
      buddies: draft.buddies,
      plannedStart: draft.plannedStart,
      plannedEnd: draft.plannedEnd,
      tideHeightM: draft.tideHeightM,
      returnPressureBar: draft.returnPressureBar,
      status: DIVE_OPEN,
      actualExit: null,
      closedAt: null,
      revision: 1,
      createdAt: new Date().toISOString()
    };
    return {
      ok: true,
      dive: dive,
      state: { dives: state.dives.concat([dive]), marks: state.marks, archive: state.archive }
    };
  }

  // 闭潜：安全闸门不通过时只能进入待复核状态（dive 保持 open，标记无法复核）
  function closeDive(state, diveId, actualExit) {
    var dive = state.dives.find(function (d) { return d.id === diveId; });
    if (!dive) return { ok: false, errors: ["潜次不存在"], state: state };
    var candidate = Object.assign({}, dive, { actualExit: actualExit });
    var errors = closureViolations(candidate);
    if (errors.length) return { ok: false, errors: errors, state: state };
    var closed = Object.assign({}, dive, {
      status: DIVE_CLOSED_PENDING,
      actualExit: actualExit,
      closedAt: new Date().toISOString()
    });
    return {
      ok: true,
      dive: closed,
      state: {
        dives: state.dives.map(function (d) { return d.id === diveId ? closed : d; }),
        marks: state.marks,
        archive: state.archive
      }
    };
  }

  function diveFieldChanged(a, b) {
    return DIVE_FIELDS.some(function (key) {
      return JSON.stringify(a[key]) !== JSON.stringify(b[key]);
    });
  }

  // 改动潜次：关联标记立即失效（旧值留档但不再导出），
  // 闭潜记录清空、修订号 +1，需重新闭潜与复核。
  function reviseDive(state, diveId, input) {
    var old = state.dives.find(function (d) { return d.id === diveId; });
    if (!old) return { ok: false, errors: ["潜次不存在"], state: state };
    var draft = normalizeDraft(Object.assign({}, input, { code: input.code || old.code }));
    var errors = draftViolations(draft);
    var dup = state.dives.find(function (d) {
      return d.id !== diveId && d.code.trim() === draft.code;
    });
    if (dup) errors.push("潜次编号与已有潜次重复");
    if (errors.length) return { ok: false, errors: errors, state: state };
    if (!diveFieldChanged(old, draft)) {
      return { ok: true, unchanged: true, dive: old, state: state, invalidated: 0 };
    }

    var linked = state.marks.filter(function (m) { return m.diveId === diveId; });
    var now = new Date().toISOString();
    var archiveEntries = linked.map(function (m) {
      return {
        id: uuid(),
        at: now,
        reason: "revise-dive",
        diveId: diveId,
        diveCode: old.code,
        markId: m.id,
        markCode: m.code,
        oldDive: clone(old),
        oldMark: clone(m)
      };
    });
    var revised = {
      id: old.id,
      code: draft.code,
      leader: draft.leader,
      buddies: draft.buddies,
      plannedStart: draft.plannedStart,
      plannedEnd: draft.plannedEnd,
      tideHeightM: draft.tideHeightM,
      returnPressureBar: draft.returnPressureBar,
      status: DIVE_OPEN,
      actualExit: null,
      closedAt: null,
      revision: old.revision + 1,
      createdAt: old.createdAt
    };
    var newMarks = state.marks.map(function (m) {
      if (m.diveId !== diveId) return m;
      return Object.assign({}, m, {
        status: MARK_INVALIDATED,
        invalidatedAt: now,
        invalidatedReason: "dive-revised",
        revisionAt: old.revision
      });
    });
    return {
      ok: true,
      dive: revised,
      invalidated: linked.length,
      state: {
        dives: state.dives.map(function (d) { return d.id === diveId ? revised : d; }),
        marks: newMarks,
        archive: state.archive.concat(archiveEntries)
      }
    };
  }

  function upsertMark(state, input) {
    var data = {
      code: String(input.code || "").trim(),
      type: input.type,
      diveId: input.diveId,
      x: Number(input.x),
      y: Number(input.y),
      depth: String(input.depth === undefined || input.depth === null ? "" : input.depth).trim(),
      orientation: String(input.orientation || "").trim(),
      condition: String(input.condition || "").trim(),
      note: String(input.note || "").trim()
    };
    var errors = markViolations(
      Object.assign({ id: input.id }, data),
      state.dives,
      state.marks
    );
    if (errors.length) return { ok: false, errors: errors, state: state };

    if (input.id) {
      var existing = state.marks.find(function (m) { return m.id === input.id; });
      if (!existing) return { ok: false, errors: ["标记不存在"], state: state };
      // 已失效标记只能留档，不能再编辑（须在修订后的潜次下重新登记）
      if (existing.status === MARK_INVALIDATED) {
        return { ok: false, errors: ["标记已失效，不能编辑；请在修订后的潜次下重新登记标记"], state: state };
      }
      // 已通过复核的标记被编辑，复核结论作废，回到待复核
      var resetApproval = existing.status === MARK_APPROVED;
      var updated = Object.assign({}, existing, data, resetApproval ? {
        status: MARK_PENDING,
        reviewedBy: null,
        reviewedAt: null,
        reviewExit: null,
        approvalResetAt: new Date().toISOString()
      } : {});
      return {
        ok: true,
        mark: updated,
        resetApproval: resetApproval,
        state: {
          dives: state.dives,
          marks: state.marks.map(function (m) { return m.id === input.id ? updated : m; }),
          archive: state.archive
        }
      };
    }
    var mark = Object.assign({
      id: uuid(),
      status: MARK_PENDING
    }, data, { createdAt: new Date().toISOString() });
    return {
      ok: true,
      mark: mark,
      state: { dives: state.dives, marks: state.marks.concat([mark]), archive: state.archive }
    };
  }

  function deleteMark(state, markId) {
    return {
      ok: true,
      state: {
        dives: state.dives,
        marks: state.marks.filter(function (m) { return m.id !== markId; }),
        archive: state.archive
      }
    };
  }

  // 复核通过后标记才计入时间线
  function approveMark(state, markId, reviewer, exitTime) {
    var mark = state.marks.find(function (m) { return m.id === markId; });
    if (!mark) return { ok: false, errors: ["标记不存在"], state: state };
    if (mark.status === MARK_INVALIDATED) {
      return { ok: false, errors: ["标记已失效，不能复核（潜次已改动，须重新登记标记）"], state: state };
    }
    var dive = state.dives.find(function (d) { return d.id === mark.diveId; });
    var errors = reviewViolations(mark, dive, reviewer, exitTime);
    if (errors.length) return { ok: false, errors: errors, state: state };

    var approved = Object.assign({}, mark, {
      status: MARK_APPROVED,
      reviewedBy: String(reviewer).trim(),
      reviewedAt: new Date().toISOString(),
      reviewExit: exitTime
    });
    return {
      ok: true,
      mark: approved,
      state: {
        dives: state.dives,
        marks: state.marks.map(function (m) { return m.id === markId ? approved : m; }),
        archive: state.archive
      }
    };
  }

  // —— 筛选（地图、列表、时间线、统计共用同一谓词）——
  function filterMarks(marks, opts) {
    opts = opts || {};
    return marks.filter(function (m) {
      if (opts.type && m.type !== opts.type) return false;
      if (opts.status && m.status !== opts.status) return false;
      if (opts.diveId && m.diveId !== opts.diveId) return false;
      return true;
    });
  }

  // —— 时间线：仅复核通过的标记计入，按潜次计划开始时间排序 ——
  function buildTimeline(marks, dives, opts) {
    var approved = filterMarks(marks, opts || {}).filter(function (m) {
      return m.status === MARK_APPROVED;
    });
    var groups = {};
    approved.forEach(function (m) { (groups[m.diveId] ||= []).push(m); });
    return Object.keys(groups).map(function (diveId) {
      var dive = dives.find(function (d) { return d.id === diveId; });
      var items = groups[diveId].slice().sort(function (a, b) {
        return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
      });
      return {
        dive: dive,
        diveCode: dive ? dive.code : "(已删除潜次)",
        plannedStart: dive ? dive.plannedStart : "",
        items: items
      };
    }).sort(function (a, b) {
      var ta = parseTime(a.plannedStart), tb = parseTime(b.plannedStart);
      if (ta === null && tb === null) return a.diveCode < b.diveCode ? -1 : 1;
      if (ta === null) return 1;
      if (tb === null) return -1;
      return ta - tb;
    });
  }

  // —— 统计（与当前筛选保持一致）——
  function computeStats(marks, dives, opts) {
    opts = opts || {};
    var data = filterMarks(marks, opts);
    var countByStatus = {};
    [MARK_PENDING, MARK_APPROVED, MARK_INVALIDATED].forEach(function (s) {
      countByStatus[s] = data.filter(function (m) { return m.status === s; }).length;
    });
    var countByType = {};
    data.forEach(function (m) { countByType[m.type] = (countByType[m.type] || 0) + 1; });
    // 按潜次筛选时，潜次数也随筛选收敛，保证数字与列表一致
    var scopedDives = opts.diveId ? dives.filter(function (d) { return d.id === opts.diveId; }) : dives;
    return {
      total: data.length,
      byStatus: countByStatus,
      byType: countByType,
      dives: scopedDives.length,
      openDives: scopedDives.filter(function (d) { return d.status === DIVE_OPEN; }).length,
      pendingReview: data.filter(function (m) { return m.status === MARK_PENDING; }).length,
      approved: data.filter(function (m) { return m.status === MARK_APPROVED; }).length,
      invalidated: data.filter(function (m) { return m.status === MARK_INVALIDATED; }).length
    };
  }

  // —— 导出：失效标记留档但不再导出；随当前筛选条件导出，保持与界面一致 ——
  function buildExport(state, opts) {
    opts = opts || {};
    var visible = filterMarks(state.marks, opts).filter(function (m) {
      return m.status !== MARK_INVALIDATED;
    });
    var linkedDiveIds = {};
    visible.forEach(function (m) { linkedDiveIds[m.diveId] = true; });
    var appliedFilter = {};
    ["type", "status", "diveId"].forEach(function (key) {
      if (opts[key]) appliedFilter[key] = opts[key];
    });
    return {
      exportedAt: new Date().toISOString(),
      appliedFilter: appliedFilter,
      rules: {
        maxTideHeightM: MAX_TIDE_HEIGHT_M,
        minBuddies: MIN_BUDDY_COUNT,
        minReturnPressureBar: MIN_RETURN_PRESSURE_BAR,
        note: "仅导出未失效标记；status 为 approved 的标记才计入潜次时间线"
      },
      dives: state.dives
        .filter(function (d) { return linkedDiveIds[d.id]; })
        .map(clone),
      marks: visible.map(clone)
    };
  }

  return {
    MAX_TIDE_HEIGHT_M: MAX_TIDE_HEIGHT_M,
    MIN_BUDDY_COUNT: MIN_BUDDY_COUNT,
    MIN_RETURN_PRESSURE_BAR: MIN_RETURN_PRESSURE_BAR,
    DIVE_OPEN: DIVE_OPEN,
    DIVE_CLOSED_PENDING: DIVE_CLOSED_PENDING,
    MARK_PENDING: MARK_PENDING,
    MARK_APPROVED: MARK_APPROVED,
    MARK_INVALIDATED: MARK_INVALIDATED,
    DIVE_FIELDS: DIVE_FIELDS,
    uuid: uuid,
    clone: clone,
    buddyNames: buddyNames,
    diverOf: diverOf,
    parseTime: parseTime,
    draftViolations: draftViolations,
    safetyViolations: safetyViolations,
    closureViolations: closureViolations,
    reviewViolations: reviewViolations,
    canApprove: canApprove,
    markViolations: markViolations,
    normalizeDraft: normalizeDraft,
    registerDive: registerDive,
    closeDive: closeDive,
    reviseDive: reviseDive,
    diveFieldChanged: diveFieldChanged,
    upsertMark: upsertMark,
    deleteMark: deleteMark,
    approveMark: approveMark,
    filterMarks: filterMarks,
    buildTimeline: buildTimeline,
    computeStats: computeStats,
    buildExport: buildExport
  };
});
