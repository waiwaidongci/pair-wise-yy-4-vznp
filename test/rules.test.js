/* Node 测试：node test/rules.test.js
 * 覆盖：登记、闭潜安全闸门、换人复核、潜次改动即失效、筛选/统计/时间线/导出一致性。
 */
const assert = require("assert");
const R = require("../js/rules.js");
const S = require("../js/storage.js");

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log("  ✓ " + name);
}

const validDraft = {
  code: "DIVE-10", leader: "甲潜", buddies: ["乙潜", "丙潜"],
  plannedStart: "2026-09-20T08:00", plannedEnd: "2026-09-20T09:30",
  tideHeightM: 0.6, returnPressureBar: 80
};

test("登记字段完整时通过", () => {
  assert.deepStrictEqual(R.draftViolations(validDraft), []);
});

test("潜伴不足两人 / 余压过低 / 潮高超限 均被安全闸门拦截", () => {
  assert.ok(R.safetyViolations({ ...validDraft, buddies: ["乙潜"] }).some(m => m.includes("潜伴不足")));
  assert.ok(R.safetyViolations({ ...validDraft, returnPressureBar: 49 }).some(m => m.includes("余压")));
  assert.ok(R.safetyViolations({ ...validDraft, tideHeightM: 0.81 }).some(m => m.includes("潮高")));
  // 边界值：0.8m、50巴、两人 正好通过
  assert.deepStrictEqual(
    R.safetyViolations({ ...validDraft, tideHeightM: 0.8, returnPressureBar: 50 }),
    []
  );
});

test("安全闸门不通过时闭潜失败，只能停留在待复核前置态", () => {
  let st = S.emptyState();
  const reg = R.registerDive(st, { ...validDraft, tideHeightM: 1.2, returnPressureBar: 30 });
  assert.strictEqual(reg.ok, true); // 登记允许（字段齐全），但无法闭潜
  st = reg.state;
  const closed = R.closeDive(st, reg.dive.id, "2026-09-20T09:20");
  assert.strictEqual(closed.ok, false);
  assert.ok(closed.errors.some(e => e.includes("潮高")));
  assert.ok(closed.errors.some(e => e.includes("余压")));
  assert.strictEqual(st.dives[0].status, R.DIVE_OPEN);
});

test("闭潜成功后标记仍为待复核，复核通过才计入时间线", () => {
  let st = S.emptyState();
  let res = R.registerDive(st, validDraft);
  st = res.state;
  const dive = res.dive;
  res = R.closeDive(st, dive.id, "2026-09-20T09:20");
  assert.strictEqual(res.ok, true, (res.errors||[]).join(";"));
  st = res.state;

  let mk = R.upsertMark(st, {
    code: "A-001", type: "ceramic", diveId: dive.id, x: 40, y: 40, depth: "17m"
  });
  st = mk.state;
  assert.strictEqual(mk.mark.status, R.MARK_PENDING);
  assert.strictEqual(R.buildTimeline(st.marks, st.dives).length, 0);

  // 复核人是本潜次潜水员 → 换人规则拦截
  let bad = R.approveMark(st, mk.mark.id, "甲潜", "2026-09-20T09:20");
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.errors.some(e => e.includes("换人")));

  // 出水时间与闭潜记录不一致 → 拦截
  bad = R.approveMark(st, mk.mark.id, "丁复核", "2026-09-20T09:25");
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.errors.some(e => e.includes("不一致")));

  // 第三人 + 出水时间一致 → 通过，计入时间线
  const ok = R.approveMark(st, mk.mark.id, "丁复核", "2026-09-20T09:20");
  assert.strictEqual(ok.ok, true, (ok.errors||[]).join(";"));
  st = ok.state;
  const tl = R.buildTimeline(st.marks, st.dives);
  assert.strictEqual(tl.length, 1);
  assert.strictEqual(tl[0].items[0].code, "A-001");
});

test("改动潜次后关联标记立即失效：旧值留档、不再导出，且需重新闭潜", () => {
  let st = S.emptyState();
  let res = R.registerDive(st, validDraft);
  st = res.state;
  const dive = res.dive;
  st = R.closeDive(st, dive.id, "2026-09-20T09:20").state;
  let mk = R.upsertMark(st, {
    code: "A-001", type: "ceramic", diveId: dive.id, x: 40, y: 40, depth: "17m"
  });
  st = mk.state;
  st = R.approveMark(st, mk.mark.id, "丁复核", "2026-09-20T09:20").state;
  assert.strictEqual(R.buildTimeline(st.marks, st.dives).length, 1);

  const revised = R.reviseDive(st, dive.id, { ...validDraft, plannedEnd: "2026-09-20T10:00" });
  assert.strictEqual(revised.ok, true);
  assert.strictEqual(revised.invalidated, 1);
  st = revised.state;

  const mark = st.marks[0];
  assert.strictEqual(mark.status, R.MARK_INVALIDATED);
  assert.strictEqual(revised.dive.status, R.DIVE_OPEN);
  assert.strictEqual(revised.dive.actualExit, null);
  assert.strictEqual(revised.dive.revision, 2);

  // 时间线移除、导出不含失效标记，但归档保留旧值
  assert.strictEqual(R.buildTimeline(st.marks, st.dives).length, 0);
  const exported = R.buildExport(st);
  assert.strictEqual(exported.marks.length, 0);
  assert.strictEqual(st.archive.length, 1);
  assert.strictEqual(st.archive[0].oldMark.code, "A-001");
  assert.strictEqual(st.archive[0].oldDive.plannedEnd, "2026-09-20T09:30");

  // 失效标记不能再复核
  const reReview = R.approveMark(st, mark.id, "丁复核", "2026-09-20T09:20");
  assert.strictEqual(reReview.ok, false);
  assert.ok(reReview.errors.some(e => e.includes("失效")));
});

test("编辑已通过的标记会撤销其复核结论，回到待复核", () => {
  let st = S.emptyState();
  let res = R.registerDive(st, validDraft);
  st = res.state;
  const dive = res.dive;
  st = R.closeDive(st, dive.id, "2026-09-20T09:20").state;
  let mk = R.upsertMark(st, { code: "A-002", type: "wood", diveId: dive.id, x: 1, y: 2, depth: "10m" });
  st = mk.state;
  st = R.approveMark(st, mk.mark.id, "丁复核", "2026-09-20T09:20").state;
  const upd = R.upsertMark(st, { id: mk.mark.id, code: "A-002", type: "wood", diveId: dive.id, x: 3, y: 4, depth: "11m" });
  assert.strictEqual(upd.ok, true);
  assert.strictEqual(upd.resetApproval, true);
  assert.strictEqual(upd.mark.status, R.MARK_PENDING);
});

test("筛选、统计、时间线共用同一筛选条件且彼此一致", () => {
  const st = S.seedState();
  const opts = { type: "ceramic" };
  const list = R.filterMarks(st.marks, opts);
  const stats = R.computeStats(st.marks, st.dives, opts);
  const tl = R.buildTimeline(st.marks, st.dives, opts);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(stats.total, 1);
  assert.strictEqual(stats.approved, 1);
  assert.strictEqual(tl[0].items.length, 1);

  // 无筛选：失效标记计入统计但永不进时间线/导出
  const all = R.computeStats(st.marks, st.dives, {});
  assert.strictEqual(all.total, 4);
  assert.strictEqual(all.invalidated, 1);
  const tlAll = R.buildTimeline(st.marks, st.dives, {});
  assert.strictEqual(tlAll.reduce((n, g) => n + g.items.length, 0), 1);
  assert.strictEqual(R.buildExport(st).marks.find(m => m.status === R.MARK_INVALIDATED), undefined);
  assert.ok(R.buildExport(st).marks.some(m => m.status === R.MARK_PENDING));
});

test("登记校验：编号重复、计划时段倒置、主潜员缺失、负压被拒", () => {
  let st = S.emptyState();
  st = R.registerDive(st, validDraft).state;
  assert.strictEqual(R.registerDive(st, { ...validDraft }).ok, false);
  assert.ok(R.draftViolations({ ...validDraft, plannedEnd: "2026-09-20T07:00" }).some(e => e.includes("结束")));
  assert.ok(R.draftViolations({ ...validDraft, leader: "  " }).some(e => e.includes("主潜员")));
  assert.ok(R.draftViolations({ ...validDraft, returnPressureBar: -1 }).some(e => e.includes("负")));
});

test("未闭潜潜次的标记不能复核", () => {
  let st = S.emptyState();
  const reg = R.registerDive(st, validDraft);
  st = reg.state;
  const mk = R.upsertMark(st, { code: "X-1", type: "metal", diveId: reg.dive.id, x: 1, y: 1, depth: "5m" });
  st = mk.state;
  const ap = R.approveMark(st, mk.mark.id, "丁复核", "2026-09-20T09:20");
  assert.strictEqual(ap.ok, false);
  assert.ok(ap.errors.some(e => e.includes("尚未闭潜")));
});

test("失效标记不能编辑，只能重新登记", () => {
  let st = S.emptyState();
  const reg = R.registerDive(st, validDraft);
  st = reg.state;
  st = R.closeDive(st, reg.dive.id, "2026-09-20T09:20").state;
  const mk = R.upsertMark(st, { code: "X-2", type: "metal", diveId: reg.dive.id, x: 1, y: 1, depth: "5m" });
  st = mk.state;
  st = R.reviseDive(st, reg.dive.id, { ...validDraft, plannedEnd: "2026-09-20T10:00" }).state;
  const edit = R.upsertMark(st, { id: mk.mark.id, code: "X-2", type: "metal", diveId: reg.dive.id, x: 9, y: 9, depth: "6m" });
  assert.strictEqual(edit.ok, false);
  assert.ok(edit.errors.some(e => e.includes("失效")));
  // 重新登记新标记可以
  const fresh = R.upsertMark(st, { code: "X-3", type: "metal", diveId: reg.dive.id, x: 9, y: 9, depth: "6m" });
  assert.strictEqual(fresh.ok, true);
});

test("按潜次筛选时统计中的潜次数随筛选收敛", () => {
  const st = S.seedState();
  const oneDive = R.computeStats(st.marks, st.dives, { diveId: "dive-demo-1" });
  assert.strictEqual(oneDive.dives, 1);
  assert.strictEqual(oneDive.total, 3); // A-017、W-003、U-010
  const none = R.computeStats(st.marks, st.dives, { diveId: "dive-demo-2" });
  assert.strictEqual(none.dives, 1);
  assert.strictEqual(none.total, 0);
});

console.log("\n全部 " + passed + " 项规则测试通过。");
