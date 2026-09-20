/* Node 下直接运行：node tests/rules.test.js
 * 用内存 localStorage 替身加载规则层与存储层，验证闭环关键路径。 */
const assert = require("assert");

// —— 宿主替身 ——
const mem = new Map();
global.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k)
};
global.crypto = { randomUUID: () => "u" + (mem.size) + "-" + Math.random().toString(16).slice(2, 8) };

require("../js/rules.js");
require("../js/storage.js");
const R = global.DiveRules;
const Store = global.DiveStore;

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log("  ✓ " + name);
}

const validDive = () => ({
  id: "d1", code: "DIVE-01",
  plannedStart: "2026-09-20T08:30", plannedEnd: "2026-09-20T10:00",
  diver1: "林远航", diver2: "苏晴",
  startPressure: 200, endPressure: 80, tideHeight: 0.6,
  actualExit: "2026-09-20T09:55", closed: false, version: 1
});
const mark = (over = {}) => ({
  id: "m1", code: "A-1", type: "ceramic", diveId: "d1", x: 1, y: 2,
  status: "pending", reviewedBy: null, reviewedAt: null,
  invalidReason: null, invalidatedAt: null, ...over
});

// —— 1. 闭潜门槛 ——
test("全部满足时门槛通过", () => {
  assert.strictEqual(R.evaluate(validDive()).ok, true);
});
test("潮高 0.8 恰好合格，0.81 不合格", () => {
  const d = validDive(); d.tideHeight = 0.8;
  assert.strictEqual(R.evaluate(d).ok, true);
  d.tideHeight = 0.81;
  const ev = R.evaluate(d);
  assert.strictEqual(ev.ok, false);
  assert.strictEqual(ev.violations[0].code, "tide");
});
test("潜伴去空白去重，少于两人不合格", () => {
  const d = validDive();
  d.diver2 = "  ";
  assert.deepStrictEqual(R.evaluate(d).checks.buddies.value, ["林远航"]);
  assert.strictEqual(R.evaluate(d).ok, false);
  d.diver2 = "林远航"; // 同名重复只算一人
  assert.strictEqual(R.evaluate(d).ok, false);
});
test("余压 50 巴恰好合格，49 巴不合格", () => {
  const d = validDive(); d.endPressure = 50;
  assert.strictEqual(R.evaluate(d).ok, true);
  d.endPressure = 49;
  const ev = R.evaluate(d);
  assert.strictEqual(ev.ok, false);
  assert.strictEqual(ev.violations[0].code, "pressure");
});
test("三项同时不通过时给出三条违规", () => {
  const d = { ...validDive(), tideHeight: 1.2, diver1: "", diver2: "", endPressure: 30 };
  assert.strictEqual(R.evaluate(d).violations.length, 3);
});

// —— 2. 复核规则 ——
const goodInput = { reviewer: "第三人", exitChecked: true };
test("门槛不满足的潜次，标记只能待复核", () => {
  const d = validDive(); d.endPressure = 30;
  assert.ok(R.reviewErrors(mark(), d, goodInput).some(e => e.includes("余压")));
});
test("没有实际出水时间不能通过", () => {
  const d = validDive(); d.actualExit = "";
  assert.ok(R.reviewErrors(mark(), d, goodInput).some(e => e.includes("实际出水时间")));
});
test("复核人必须换人，不能是两名潜水员", () => {
  const d = validDive();
  assert.ok(R.reviewErrors(mark(), d, { reviewer: "苏晴", exitChecked: true })
    .some(e => e.includes("换人")));
  assert.ok(R.reviewErrors(mark(), d, { reviewer: "林远航", exitChecked: true })
    .some(e => e.includes("换人")));
  // 姓名两侧空白不影响换人判定
  assert.ok(R.reviewErrors(mark(), d, { reviewer: " 苏晴 ", exitChecked: true })
    .some(e => e.includes("换人")));
});
test("不勾选核对实际出水时间不能通过", () => {
  assert.ok(R.reviewErrors(mark(), validDive(), { reviewer: "第三人", exitChecked: false })
    .some(e => e.includes("已核对")));
});
test("全部满足时复核无阻塞", () => {
  assert.deepStrictEqual(R.reviewErrors(mark(), validDive(), goodInput), []);
});
test("已失效标记不可复核（旧值留档）", () => {
  assert.ok(R.reviewErrors(mark({ status: "invalid" }), validDive(), goodInput)
    .some(e => e.includes("失效")));
});
test("未关联潜次不可复核", () => {
  assert.ok(R.reviewErrors(mark({ diveId: "nope" }), null, goodInput).some(e => e.includes("未关联潜次")));
});

// —— 3. 改动潜次 → 关联标记立即失效 ——
test("改动潜次使待复核/已通过标记立即失效，他潜次不受影响", () => {
  const marks = [
    mark({ id: "a", status: "pending" }),
    mark({ id: "b", diveId: "d2", status: "approved", reviewedBy: "第三人", reviewedAt: "t" }),
    mark({ id: "c", status: "approved", reviewedBy: "第三人", reviewedAt: "t" })
  ];
  const out = R.invalidateMarks(marks, "d1", "2026-09-20T12:00:00Z");
  assert.strictEqual(out[0].status, "invalid");
  assert.strictEqual(out[0].invalidReason, "dive-changed");
  assert.strictEqual(out[0].invalidatedAt, "2026-09-20T12:00:00Z");
  assert.strictEqual(out[0].code, "A-1"); // 旧值保留
  assert.strictEqual(out[1].status, "approved"); // 别的潜次
  assert.strictEqual(out[2].status, "invalid");
});
test("已失效标记不会被重复改动或复活", () => {
  const out = R.invalidateMarks([mark({ status: "invalid" })], "d1");
  assert.strictEqual(out[0].status, "invalid");
  assert.strictEqual(R.toPending(mark({ status: "invalid" })).status, "invalid");
});
test("编辑未失效标记：已通过复核作废、回到待复核", () => {
  const m = mark({ status: "approved", reviewedBy: "第三人", reviewedAt: "t" });
  const out = R.toPending(m);
  assert.strictEqual(out.status, "pending");
  assert.strictEqual(out.reviewedBy, null);
});

// —— 4. 变更检测 ——
test("diveChanged 识别安全相关字段改动", () => {
  const d = validDive();
  assert.strictEqual(R.diveChanged(d, { ...d, endPressure: 90 }), true);
  assert.strictEqual(R.diveChanged(d, { ...d }), false);
});
test("markChanged 识别标记编辑", () => {
  const m = mark();
  assert.strictEqual(R.markChanged(m, { ...m, note: "x" }), true);
  assert.strictEqual(R.markChanged(m, { ...m }), false);
});

// —— 5. 统计 ——
test("markStats 按状态汇总", () => {
  const s = R.markStats([mark(), mark({ status: "approved" }), mark({ status: "invalid" })]);
  assert.deepStrictEqual(s, { total: 3, pending: 1, approved: 1, invalid: 1 });
});

// —— 6. 导出：旧值不导出、失效标记不导出 ——
test("buildExport 剥离潜次 history 并不导出已失效标记", () => {
  const state = {
    dives: [{ ...validDive(), history: [{ at: "old", value: { endPressure: 200 } }], version: 2 }],
    marks: [
      mark({ id: "p", status: "pending" }),
      mark({ id: "a", status: "approved" }),
      mark({ id: "x", status: "invalid" })
    ]
  };
  const out = R.buildExport(state);
  assert.strictEqual(out.dives[0].history, undefined);
  assert.strictEqual(out.dives[0].version, 2);
  assert.deepStrictEqual(out.marks.map(m => m.id), ["p", "a"]);
});

// —— 7. 存储层：种子、往返、留档 ——
test("Store.load 首次生成种子数据并持久化", () => {
  const s = Store.load();
  assert.ok(s.dives.length >= 2 && s.marks.length >= 3);
  const again = Store.load();
  assert.strictEqual(again.dives[0].id, s.dives[0].id);
});
test("archiveDive 旧值留档且版本递增", () => {
  const s = Store.load();
  const dive = s.dives[0];
  const beforeVersion = dive.version;
  Store.archiveDive(dive, { ...R.DIVE_FIELDS.reduce((o, f) => (o[f] = dive[f], o), {}), closed: dive.closed });
  assert.strictEqual(dive.version, beforeVersion + 1);
  assert.strictEqual(dive.history.length, 1);
  assert.ok(dive.history[0].at);
});
test("newMark 默认待复核，newDive 字段齐全", () => {
  const m = Store.newMark("M-9", "d1", 10, 20);
  assert.strictEqual(m.status, "pending");
  assert.strictEqual(m.x, 10);
  const d = Store.newDive();
  R.DIVE_FIELDS.forEach(f => assert.ok(f in d, "潜次缺字段 " + f));
});

// —— 8. 端到端闭环（用存储对象模拟一遍）——
test("端到端：登记→标记→复核→闭潜→改动失效→再复核→导出", () => {
  mem.clear();
  let s = Store.load();
  const dive = s.dives[0];
  // 种子潜次1满足门槛，标记1挂在其上
  const target = s.marks.find(m => m.diveId === dive.id && m.code === "A-017");
  assert.strictEqual(target.status, "pending");
  // 复核换人 + 核对出水
  assert.deepStrictEqual(R.reviewErrors(target, dive, { reviewer: "陈观", exitChecked: true }), []);
  target.status = "approved";
  target.reviewedBy = "陈观";
  target.reviewedAt = "2026-09-20T10:10";
  Store.save(s);
  // 刷新后状态仍在
  s = Store.load();
  assert.strictEqual(s.marks.find(m => m.id === target.id).status, "approved");
  // 改动潜次余压 → 关联标记立即失效
  const refreshed = s.dives.find(d => d.id === dive.id);
  const old = { ...refreshed };
  refreshed.endPressure = 40; // 同时跌破 50 巴
  Store.archiveDive(refreshed, old);
  s.marks = R.invalidateMarks(s.marks, refreshed.id);
  Store.save(s);
  const invalid = s.marks.filter(m => m.diveId === refreshed.id);
  assert.ok(invalid.every(m => m.status === "invalid"));
  assert.strictEqual(R.evaluate(refreshed).ok, false);
  // 导出中看不到失效标记，潜次旧值也不出现
  const exported = R.buildExport(s);
  assert.ok(!exported.marks.some(m => m.diveId === refreshed.id));
  assert.strictEqual(exported.dives.find(d => d.id === refreshed.id).history, undefined);
  // 但本地留档还在
  const local = Store.load();
  assert.ok(local.dives.find(d => d.id === refreshed.id).history.length >= 1);
  // 恢复余压后新标记可以重新走复核闭环
  refreshed.endPressure = 90;
  assert.strictEqual(R.evaluate(refreshed).ok, true);
  const nm = Store.newMark("M-NEW", refreshed.id, 50, 50);
  assert.deepStrictEqual(R.reviewErrors(nm, refreshed, { reviewer: "陈观", exitChecked: true }), []);
});

console.log(`\n全部通过：${passed} 项测试`);
