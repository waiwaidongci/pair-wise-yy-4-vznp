/*
 * 存储层：只管数据的读写、迁移与演示数据，不包含任何业务判定，
 * 也不操作 DOM（localStorage 由宿主注入，可在 Node 中测试）。
 */
(function (global) {
  "use strict";

  const KEY = "zfl30.diveLog.v2";
  const LEGACY_KEY = "zfl30Marks"; // 旧版单文件应用的数据

  function getStore() {
    return global.localStorage;
  }

  function load() {
    let state = null;
    try {
      const raw = getStore().getItem(KEY);
      if (raw) state = JSON.parse(raw);
    } catch (err) {
      console.warn("潜水记录解析失败，回退到空数据", err);
    }
    if (!state || !Array.isArray(state.dives) || !Array.isArray(state.marks)) {
      state = seedState();
      migrateLegacy(state); // 兼容旧版 key（如有）
      save(state);
    }
    return state;
  }

  function save(state) {
    getStore().setItem(KEY, JSON.stringify(state));
    return state;
  }

  // 潜次改动留档：旧值压入 history，版本号 +1（存储层只负责记账，不做判定）。
  // 只快照数据字段，剥掉 history/version，避免把留档数组自身存进去形成环。
  function archiveDive(dive, oldValue, at) {
    const fields = ["code", "plannedStart", "plannedEnd", "diver1", "diver2",
      "startPressure", "endPressure", "tideHeight", "actualExit", "closed"];
    const snapshot = {};
    fields.forEach(f => { snapshot[f] = oldValue[f]; });
    if (!dive.history) dive.history = [];
    dive.history.push({
      at: at || new Date().toISOString(),
      value: snapshot
    });
    dive.version = (Number(dive.version) || 1) + 1;
    return dive;
  }

  // —— 工厂函数 ——
  function newDive() {
    return {
      id: global.crypto.randomUUID(),
      code: "DIVE-" + String(Date.now()).slice(-3),
      plannedStart: "",
      plannedEnd: "",
      diver1: "",
      diver2: "",
      startPressure: "",
      endPressure: "",
      tideHeight: "",
      actualExit: "",
      closed: false,
      version: 1,
      history: []
    };
  }

  function newMark(code, diveId, x, y) {
    return {
      id: global.crypto.randomUUID(),
      code: code || "M-000",
      type: "unknown",
      diveId: diveId || "",
      x: Number(x) || 50,
      y: Number(y) || 50,
      depth: "",
      orientation: "",
      condition: "",
      note: "",
      status: "pending", // pending 待复核 / approved 已通过 / invalid 已失效
      reviewedBy: null,
      reviewedAt: null,
      invalidReason: null,
      invalidatedAt: null
    };
  }

  function seedState() {
    const d1 = {
      id: global.crypto.randomUUID(),
      code: "DIVE-01",
      plannedStart: "2026-09-20T08:30",
      plannedEnd: "2026-09-20T10:00",
      diver1: "林远航",
      diver2: "苏晴",
      startPressure: 200,
      endPressure: 80,
      tideHeight: 0.6,
      actualExit: "2026-09-20T09:55",
      closed: false,
      version: 1,
      history: []
    };
    const d2 = {
      id: global.crypto.randomUUID(),
      code: "DIVE-02",
      plannedStart: "2026-09-20T13:00",
      plannedEnd: "2026-09-20T14:30",
      diver1: "周明",
      diver2: "",
      startPressure: 190,
      endPressure: 40,
      tideHeight: 1.1,
      actualExit: "",
      closed: false,
      version: 1,
      history: []
    };
    return {
      dives: [d1, d2],
      marks: [
        { ...newMark("A-017", d1.id, 42, 46), type: "ceramic", depth: "17.8m", orientation: "东", condition: "边缘残缺", note: "靠近船肋" },
        { ...newMark("W-003", d1.id, 58, 39), type: "wood", depth: "18.2m", orientation: "西北", condition: "稳定", note: "疑似横梁" },
        { ...newMark("M-004", d2.id, 35, 60), type: "metal", depth: "16.9m", orientation: "南", condition: "待清洗", note: "潮高异常，未闭潜" }
      ]
    };
  }

  // 旧版标记只有 dive 编号（如 DIVE-01），按编号挂到登记潜次上；
  // 找不到登记潜次则补一条未登记潜次，保持旧数据可追溯。
  function migrateLegacy(state) {
    let raw = null;
    try {
      raw = getStore().getItem(LEGACY_KEY);
    } catch (err) {
      return;
    }
    if (!raw) return;
    let legacy;
    try {
      legacy = JSON.parse(raw);
    } catch (err) {
      return;
    }
    if (!Array.isArray(legacy) || !legacy.length) return;

    const placeholders = new Map();
    legacy.forEach(old => {
      let dive = state.dives.find(d => d.code === old.dive);
      if (!dive) {
        dive = placeholders.get(old.dive);
        if (!dive) {
          dive = newDive();
          dive.code = old.dive || "DIVE-未登记";
          placeholders.set(old.dive, dive);
          state.dives.push(dive);
        }
      }
      state.marks.push({
        ...newMark(old.code, dive.id, old.x, old.y),
        type: old.type || "unknown",
        depth: old.depth || "",
        orientation: old.orientation || "",
        condition: old.condition || "",
        note: old.note || ""
      });
    });
  }

  global.DiveStore = {
    KEY,
    LEGACY_KEY,
    load,
    save,
    archiveDive,
    newDive,
    newMark
  };
})(typeof window !== "undefined" ? window : globalThis);
