/*
 * 规则层：潮汐窗口与安全余压闭环的全部业务规则。
 * 纯函数，不访问 DOM 也不访问 localStorage，便于单独测试与复用。
 */
(function (global) {
  "use strict";

  // —— 硬性安全阈值（闭潜门槛）——
  const TIDE_LIMIT_M = 0.8;    // 潮高超过 0.8m 不得闭潜（0.8 整视为合格）
  const MIN_BUDDIES = 2;       // 潜伴不足两人不得闭潜
  const MIN_RESIDUAL_BAR = 50; // 余压低于 50 巴不得闭潜（50 整视为合格）

  // 潜次登记字段；其中任意一项的“已保存值”发生变化即视为改动潜次
  const DIVE_FIELDS = [
    "code", "plannedStart", "plannedEnd",
    "diver1", "diver2",
    "startPressure", "endPressure", "tideHeight",
    "actualExit"
  ];

  // 标记可编辑字段；改动后需要重新复核
  const MARK_FIELDS = ["code", "type", "diveId", "depth", "orientation", "condition", "note"];

  function toNumber(value) {
    if (value === "" || value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isNaN(n) ? null : n;
  }

  // 两名潜伴：去空白、去重
  function buddies(dive) {
    const raw = dive ? [dive.diver1, dive.diver2] : [];
    return [...new Set(raw.map(v => String(v ?? "").trim()).filter(Boolean))];
  }

  /*
   * 评估潜次是否满足闭潜条件。
   * 返回 { ok, checks, violations:[{code,message}] }
   */
  function evaluate(dive) {
    const tide = toNumber(dive && dive.tideHeight);
    const residual = toNumber(dive && dive.endPressure);
    const names = buddies(dive);

    const checks = {
      tide: { ok: tide !== null && tide <= TIDE_LIMIT_M, value: tide },
      buddies: { ok: names.length >= MIN_BUDDIES, value: names },
      pressure: { ok: residual !== null && residual >= MIN_RESIDUAL_BAR, value: residual }
    };

    const violations = [];
    if (!checks.tide.ok) {
      violations.push({
        code: "tide",
        message: tide === null
          ? "未登记潮高，无法确认潮汐窗口"
          : `潮高 ${tide}m 超过 ${TIDE_LIMIT_M}m 上限`
      });
    }
    if (!checks.buddies.ok) {
      violations.push({
        code: "buddies",
        message: names.length === 0
          ? "未登记两名潜水员"
          : `潜伴仅 ${names.length} 人，不足两人`
      });
    }
    if (!checks.pressure.ok) {
      violations.push({
        code: "pressure",
        message: residual === null
          ? "未登记返回压力（余压）"
          : `余压 ${residual} 巴，低于 ${MIN_RESIDUAL_BAR} 巴`
      });
    }

    return { ok: violations.length === 0, checks, violations };
  }

  /*
   * 复核前置校验：
   * 1) 标记未失效且关联了潜次；
   * 2) 潜次满足全部闭潜门槛（否则标记只能停留在待复核）；
   * 3) 潜次已登记实际出水时间，且复核人勾选“已核对”；
   * 4) 复核须换人——复核人不能是本次两名潜水员中的任何一人。
   */
  function reviewErrors(mark, dive, input) {
    const errors = [];

    if (!mark || mark.status === "invalid") {
      errors.push("标记已随潜次改动失效，旧值留档但不可复核");
    }
    if (!dive) {
      errors.push("标记未关联潜次");
    }
    if (dive) {
      const ev = evaluate(dive);
      if (!ev.ok) errors.push(...ev.violations.map(v => v.message));
      if (!String(dive.actualExit || "").trim()) {
        errors.push("潜次尚未登记实际出水时间");
      }
    }

    const reviewer = String((input && input.reviewer) || "").trim();
    if (!reviewer) {
      errors.push("须填写复核人");
    } else if (dive && buddies(dive).includes(reviewer)) {
      errors.push("复核须换人：复核人不能是本次潜水员");
    }
    if (!input || !input.exitChecked) {
      errors.push("须勾选已核对实际出水时间");
    }
    return errors;
  }

  // 改动潜次：关联标记立即失效（原地状态更新，保留旧值）
  function invalidateMarks(marks, diveId, at) {
    const stamp = at || new Date().toISOString();
    return marks.map(m => {
      if (m.diveId !== diveId || m.status === "invalid") return m;
      return {
        ...m,
        status: "invalid",
        invalidatedAt: stamp,
        invalidReason: "dive-changed"
      };
    });
  }

  // 编辑未失效标记：已通过的复核作废，回到待复核；已失效标记不得借此复活
  function toPending(mark) {
    if (!mark || mark.status === "invalid") return mark;
    return { ...mark, status: "pending", reviewedBy: null, reviewedAt: null };
  }

  function diveChanged(before, after) {
    return DIVE_FIELDS.some(
      f => String((before || {})[f] ?? "") !== String((after || {})[f] ?? "")
    );
  }

  function markChanged(before, after) {
    return MARK_FIELDS.some(
      f => String((before || {})[f] ?? "") !== String((after || {})[f] ?? "")
    );
  }

  function markStats(marks) {
    const stats = { total: marks.length, pending: 0, approved: 0, invalid: 0 };
    for (const m of marks) {
      if (stats[m.status] !== undefined) stats[m.status] += 1;
    }
    return stats;
  }

  function diveStats(dives) {
    return {
      total: dives.length,
      closed: dives.filter(d => d.closed).length
    };
  }

  /*
   * 导出：只导出现行值。
   * - 潜次剥掉 history（旧值仅留档，不导出）；
   * - 已失效标记不导出；待复核与已通过标记照常导出并带状态。
   */
  function buildExport(state) {
    return {
      exportedAt: new Date().toISOString(),
      dives: (state.dives || []).map(d => {
        const copy = { ...d };
        delete copy.history;
        return copy;
      }),
      marks: (state.marks || []).filter(m => m.status !== "invalid")
    };
  }

  global.DiveRules = {
    TIDE_LIMIT_M,
    MIN_BUDDIES,
    MIN_RESIDUAL_BAR,
    DIVE_FIELDS,
    MARK_FIELDS,
    buddies,
    evaluate,
    reviewErrors,
    invalidateMarks,
    toPending,
    diveChanged,
    markChanged,
    markStats,
    diveStats,
    buildExport
  };
})(typeof window !== "undefined" ? window : globalThis);
