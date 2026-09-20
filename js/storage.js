/*
 * 存储层：负责状态持久化、版本迁移、示例数据与界面偏好。
 * 不包含任何业务规则判断；所有变更动作仍调用规则层 DiveRules 完成。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./rules.js"));
  } else root.DiveStore = factory(root.DiveRules);
})(typeof self !== "undefined" ? self : this, function (R) {
  "use strict";

  var STATE_KEY = "zfl30DiveState.v1";
  var PREFS_KEY = "zfl30DivePrefs.v1";

  function emptyState() {
    return { version: 1, dives: [], marks: [], archive: [] };
  }

  function normalizeState(raw) {
    var state = raw || {};
    ["dives", "marks", "archive"].forEach(function (key) {
      if (!Array.isArray(state[key])) state[key] = [];
    });
    state.dives.forEach(function (d) {
      d.buddies = Array.isArray(d.buddies) ? d.buddies : [];
      d.status = d.status || R.DIVE_OPEN;
      d.revision = d.revision || 1;
      if (d.actualExit === undefined) d.actualExit = null;
    });
    state.marks.forEach(function (m) {
      m.status = m.status || R.MARK_PENDING;
    });
    return state;
  }

  // 首次使用的演示数据：覆盖 已通过 / 待复核 / 安全闸门不通过 / 已失效 四种情形
  function seedState() {
    var d1 = {
      id: "dive-demo-1", code: "DIVE-01", leader: "林澜",
      buddies: ["周潜", "郑涌"],
      plannedStart: "2026-09-14T08:30", plannedEnd: "2026-09-14T10:00",
      tideHeightM: 0.62, returnPressureBar: 90,
      status: R.DIVE_CLOSED_PENDING,
      actualExit: "2026-09-14T09:55", closedAt: "2026-09-14T10:05:00.000Z",
      revision: 1, createdAt: "2026-09-13T03:00:00.000Z"
    };
    var d2 = {
      id: "dive-demo-2", code: "DIVE-02", leader: "苏岩",
      buddies: ["何潜"],
      plannedStart: "2026-09-15T09:00", plannedEnd: "2026-09-15T10:30",
      tideHeightM: 0.55, returnPressureBar: 75,
      status: R.DIVE_OPEN, actualExit: null, closedAt: null,
      revision: 1, createdAt: "2026-09-14T08:00:00.000Z"
    };
    var d3 = {
      id: "dive-demo-3", code: "DIVE-03", leader: "高远",
      buddies: ["梁汐", "韩潮"],
      plannedStart: "2026-09-16T13:00", plannedEnd: "2026-09-16T14:30",
      // 潮高 1.05m > 0.8m 且余压 40 巴 < 50 巴：安全闸门不通过，不能闭潜
      tideHeightM: 1.05, returnPressureBar: 40,
      status: R.DIVE_OPEN, actualExit: null, closedAt: null,
      revision: 1, createdAt: "2026-09-15T06:00:00.000Z"
    };
    var m1 = {
      id: "mark-demo-1", code: "A-017", type: "ceramic", diveId: d1.id,
      x: 42, y: 46, depth: "17.8m", orientation: "东", condition: "边缘残缺",
      note: "靠近船肋", status: R.MARK_APPROVED,
      reviewedBy: "许复核", reviewedAt: "2026-09-14T11:00:00.000Z",
      reviewExit: d1.actualExit, createdAt: "2026-09-14T02:00:00.000Z"
    };
    var m2 = {
      id: "mark-demo-2", code: "W-003", type: "wood", diveId: d1.id,
      x: 58, y: 39, depth: "18.2m", orientation: "西北", condition: "稳定",
      note: "疑似横梁", status: R.MARK_PENDING,
      createdAt: "2026-09-14T02:10:00.000Z"
    };
    var m3 = {
      id: "mark-demo-3", code: "M-008", type: "metal", diveId: d3.id,
      x: 35, y: 60, depth: "19.1m", orientation: "南", condition: "表面锈蚀",
      note: "大潮急流中仓促记录", status: R.MARK_PENDING,
      createdAt: "2026-09-16T06:00:00.000Z"
    };
    var m4 = {
      id: "mark-demo-4", code: "U-010", type: "unknown", diveId: d1.id,
      x: 47, y: 53, depth: "18.0m", orientation: "北", condition: "泥沙覆盖",
      note: "潜次时段被修正后失效，留档示例", status: R.MARK_INVALIDATED,
      invalidatedAt: "2026-09-14T12:00:00.000Z", invalidatedReason: "dive-revised",
      revisionAt: 1, createdAt: "2026-09-14T02:20:00.000Z"
    };
    var state = {
      version: 1,
      dives: [d1, d2, d3],
      marks: [m1, m2, m3, m4],
      archive: [{
        id: "archive-demo-1",
        at: "2026-09-14T12:00:00.000Z",
        reason: "revise-dive",
        diveId: d1.id, diveCode: "DIVE-01",
        markId: m4.id, markCode: "U-010",
        oldDive: R.clone(Object.assign({}, d1, {
          plannedStart: "2026-09-14T07:30", plannedEnd: "2026-09-14T09:00"
        })),
        oldMark: R.clone(m4)
      }]
    };
    return state;
  }

  // 旧版（zfl30Marks）单文件应用的标记数据迁移：归到一个未闭潜潜次下待复核
  function migrateLegacy() {
    try {
      var raw = localStorage.getItem("zfl30Marks");
      if (!raw) return null;
      var oldMarks = JSON.parse(raw);
      if (!Array.isArray(oldMarks) || !oldMarks.length) return null;
      var dive = {
        id: R.uuid(), code: "DIVE-OLD", leader: "", buddies: [],
        plannedStart: "", plannedEnd: "", tideHeightM: "", returnPressureBar: "",
        status: R.DIVE_OPEN, actualExit: null, closedAt: null,
        revision: 1, createdAt: new Date().toISOString()
      };
      var marks = oldMarks.map(function (m) {
        return {
          id: R.uuid(), code: String(m.code || ""), type: m.type || "unknown",
          diveId: dive.id,
          x: Number(m.x) || 50, y: Number(m.y) || 50,
          depth: String(m.depth || ""), orientation: String(m.orientation || ""),
          condition: String(m.condition || ""), note: String(m.note || ""),
          status: R.MARK_PENDING,
          createdAt: new Date().toISOString()
        };
      });
      return { version: 1, dives: [dive], marks: marks, archive: [] };
    } catch (e) {
      return null;
    }
  }

  function load() {
    var state = null;
    try {
      var raw = localStorage.getItem(STATE_KEY);
      if (raw) state = normalizeState(JSON.parse(raw));
    } catch (e) { state = null; }
    if (!state) state = migrateLegacy();
    if (!state) {
      state = seedState();
      save(state);
    }
    return state;
  }

  function save(state) {
    localStorage.setItem(STATE_KEY, JSON.stringify(normalizeState(state)));
  }

  function loadPrefs() {
    try {
      return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    } catch (e) { return {}; }
  }

  function savePrefs(prefs) {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs || {}));
  }

  function exportJson(state, opts) {
    return JSON.stringify(R.buildExport(state, opts), null, 2);
  }

  return {
    STATE_KEY: STATE_KEY,
    PREFS_KEY: PREFS_KEY,
    emptyState: emptyState,
    normalizeState: normalizeState,
    seedState: seedState,
    load: load,
    save: save,
    loadPrefs: loadPrefs,
    savePrefs: savePrefs,
    exportJson: exportJson
  };
});
