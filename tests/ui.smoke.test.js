/* 界面冒烟测试（jsdom）：node tests/ui.smoke.test.js
 * 模拟真实点击，验证规则/存储/界面三层联动，以及刷新后一致。 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const rulesSrc = fs.readFileSync(path.join(__dirname, "..", "js", "rules.js"), "utf8");
const storageSrc = fs.readFileSync(path.join(__dirname, "..", "js", "storage.js"), "utf8");
const appSrc = fs.readFileSync(path.join(__dirname, "..", "js", "app.js"), "utf8");

let bootSeq = 0;
function boot(dump, uiDump) {
  // 每次 boot 用独立来源，避免 jsdom 同源 localStorage 跨用例污染
  const url = `https://example${++bootSeq}.test/`;
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url,
    pretendToBeVisual: true
  });
  const { window } = dom;
  if (dump) window.localStorage.setItem("zfl30.diveLog.v2", dump);
  if (uiDump) window.localStorage.setItem("zfl30.diveLog.ui", uiDump);
  window.confirm = () => true;
  window.alert = msg => { throw new Error("未预期的 alert: " + msg); };
  window.eval(rulesSrc);
  window.eval(storageSrc);
  window.eval(appSrc);
  return dom;
}

let passed = 0;
function check(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function test(name, fn) {
  await fn();
  passed++;
  console.log("  ✓ " + name);
}
// 辅助函数第一个参数统一传 document
const $ = (d, sel) => d.querySelector(sel);
const $$ = (d, sel) => [...d.querySelectorAll(sel)];
const setVal = (d, el, value) => {
  el.value = value;
  el.dispatchEvent(new d.defaultView.Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
};

(async () => {
  // —— 初始渲染 ——
  let dom = boot();
  let win = dom.window;
  let doc = win.document;

  await test("初始：统计瓦片 3 标记 / 3 待复核 / 0 通过 / 0 失效 / 0-2 闭潜", () => {
    const tiles = $$(doc, "#stats .tile b").map(b => b.textContent);
    check(JSON.stringify(tiles) === JSON.stringify(["3", "3", "0", "0", "0/2"]),
      "统计不符: " + tiles.join(","));
  });

  await test("初始：DIVE-01 门槛全绿（潮高/潜伴/余压）", () => {
    check($(doc, "#gate").className.includes("pass"), "应为 pass");
    check($$(doc, "#gate .check.ok").length === 3, "应 3 条通过");
  });

  await test("初始：地图 3 个标记全部待复核", () => {
    check($$(doc, "#map .marker").length === 3, "应有 3 个标记");
    check($$(doc, "#map .marker.st-pending").length === 3, "应全部待复核");
  });

  await test("DIVE-02 三项门槛全红，登记闭潜被拒", () => {
    const sel = $(doc, "#diveSelect");
    sel.value = $$(doc, "#diveSelect option")[1].value;
    sel.dispatchEvent(new win.Event("change"));
    const gate = $(doc, "#gate");
    check(gate.className.includes("fail"), "应为 fail");
    check($$(doc, "#gate .check.bad").length === 3, "应 3 条不通过");
    let blocked = false;
    win.alert = () => { blocked = true; };
    $(doc, "#closeDiveBtn").click();
    check(blocked, "门槛不满足时不得闭潜");
    win.alert = msg => { throw new Error("未预期的 alert: " + msg); };
  });

  // —— 复核闭环 ——
  await test("选中标记后复核区列出阻塞项", () => {
    const sel = $(doc, "#diveSelect");
    sel.value = $$(doc, "#diveSelect option")[0].value;
    sel.dispatchEvent(new win.Event("change"));
    $$(doc, "#map .marker")[0].click();
    check($(doc, "#reviewBox").className.includes("pending"), "应为待复核");
    check($$(doc, "#reviewBox .blockers li").length >= 2, "应至少有 2 条阻塞");
  });

  await test("复核人是潜水员之一时换人校验拦截（按钮禁用且点击无效）", () => {
    setVal(doc, $(doc, "#reviewer"), "苏晴");
    check($$(doc, "#reviewBox .blockers li").some(li => li.textContent.includes("换人")),
      "应提示复核须换人");
    check($(doc, "#approveBtn").disabled === true, "存在阻塞时通过按钮应禁用");
    let blocked = false;
    win.alert = () => { blocked = true; };
    $(doc, "#approveBtn").click();
    check(!blocked, "禁用按钮不应触发弹窗");
    check($(doc, "#reviewBox").className.includes("pending"), "标记应仍是待复核");
    win.alert = msg => { throw new Error("未预期的 alert: " + msg); };
  });

  await test("换人 + 核对实际出水时间后按钮可用，通过后统计与时间线同步", () => {
    setVal(doc, $(doc, "#reviewer"), "陈观");
    const cb = $(doc, "#exitChecked");
    cb.checked = true;
    cb.dispatchEvent(new win.Event("change"));
    check($$(doc, "#reviewBox .blockers li").length === 0, "阻塞项应清零");
    check($(doc, "#approveBtn").disabled === false, "无阻塞时按钮应可用");
    $(doc, "#approveBtn").click();
    check($(doc, "#reviewBox").className.includes("approved"), "应显示已通过");
    const tiles = $$(doc, "#stats .tile b").map(b => b.textContent);
    check(tiles[1] === "2" && tiles[2] === "1", "统计应 待复核2/通过1，实际 " + tiles.join(","));
    setVal(doc, $(doc, "#view"), "timeline");
    const text = $(doc, "#list").textContent;
    check(text.includes("A-017") && !text.includes("W-003") && !text.includes("M-004"),
      "时间线只应有 A-017");
    check(text.includes("复核：陈观"), "时间线应显示复核人");
    setVal(doc, $(doc, "#view"), "list");
  });

  // —— 筛选 ——
  await test("状态筛选=待复核：地图、列表、统计共用同一份过滤结果", () => {
    setVal(doc, $(doc, "#filterStatus"), "pending");
    check($$(doc, "#map .marker").length === 2, "地图应剩 2 个");
    check($$(doc, "#list .item").length === 2, "列表应剩 2 项");
    setVal(doc, $(doc, "#filterType"), "metal");
    check($$(doc, "#list .item").length === 1, "金属件+待复核应剩 1 项");
    setVal(doc, $(doc, "#filterType"), "");
    setVal(doc, $(doc, "#filterStatus"), "");
  });

  // —— 改动潜次 → 关联标记立即失效 ——
  await test("余压改为 40 保存后：关联两标记立即失效、时间线清空", () => {
    const sel = $(doc, "#diveSelect");
    sel.value = $$(doc, "#diveSelect option")[0].value;
    sel.dispatchEvent(new win.Event("change"));
    const f = $(doc, "#diveForm").elements;
    setVal(doc, f.endPressure, "40");
    check($(doc, "#gate").className.includes("fail"), "余压 40 应变红");
    win.alert = () => {}; // 保存后的门槛提示为预期信息
    $(doc, "#diveForm").dispatchEvent(new win.Event("submit"));
    win.alert = msg => { throw new Error("未预期的 alert: " + msg); };
    const tiles = $$(doc, "#stats .tile b").map(b => b.textContent);
    check(tiles[3] === "2", "DIVE-01 两标记都应失效，实际 " + tiles.join(","));
    check($$(doc, "#map .marker.st-invalid").length === 2, "地图应有 2 个失效样式");
    setVal(doc, $(doc, "#view"), "timeline");
    check($(doc, "#list").textContent.includes("没有已通过复核"), "时间线应清空并提示");
    setVal(doc, $(doc, "#view"), "list");
  });

  await test("选中失效标记：表单禁用、复核区说明旧值留档", () => {
    $$(doc, "#map .marker.st-invalid")[0].click();
    check($(doc, "#markFields").disabled, "失效标记表单应禁用");
    check($(doc, "#reviewBox").textContent.includes("旧值"), "应提示旧值留档");
    check($(doc, "#reviewBox").textContent.includes("不导出") ||
      $(doc, "#reviewBox").textContent.includes("不再导出"), "应提示不导出");
  });

  // —— 导出 ——
  await test("导出 JSON：失效标记与 history 旧值都不出现", () => {
    let exported = null;
    win.URL.createObjectURL = blob => { exported = blob; return "blob:x"; };
    win.URL.revokeObjectURL = () => {};
    win.HTMLAnchorElement.prototype.click = function () {};
    $(doc, "#exportBtn").click();
    return exported.text().then(json => {
      const data = JSON.parse(json);
      check(!data.marks.some(m => m.status === "invalid"), "失效标记不应导出");
      check(data.marks.length === 1, "只应导出 M-004，实际 " + data.marks.length);
      check(!data.dives.some(d => d.history), "history 旧值不应导出");
      check(data.dives.some(d => d.code === "DIVE-01"), "潜次仍应导出（现行值）");
    });
  });

  // —— 刷新后一致 ——
  const dump = win.localStorage.getItem("zfl30.diveLog.v2");
  const uiDump = win.localStorage.getItem("zfl30.diveLog.ui");

  await test("刷新重建：改动、失效状态、旧值留档与筛选偏好全部恢复", () => {
    const dom2 = boot(dump, uiDump);
    const w2 = dom2.window, d2 = w2.document;
    const data = JSON.parse(dump);
    const d1 = data.dives.find(d => d.code === "DIVE-01");
    check(Number(d1.endPressure) === 40, "余压改动应持久化");
    check(d1.history && d1.history.length === 1, "应留档一条旧值");
    check(Number(d1.history[0].value.endPressure) === 80, "留档旧值应为 80 巴");
    check(data.marks.filter(m => m.diveId === d1.id).every(m => m.status === "invalid"),
      "失效状态应持久化");
    // UI 恢复：DIVE-01 被选中、视图=list（筛选已在测试中清空）
    check(d2.querySelector("#diveSelect").selectedOptions[0].textContent.startsWith("DIVE-01"),
      "应恢复上次查看的潜次");
    check($$(d2, "#map .marker.st-invalid").length === 2, "界面应重绘 2 个失效标记");
    const tiles = $$(d2, "#stats .tile b").map(b => b.textContent);
    check(tiles[3] === "2", "刷新后统计仍应为失效 2");
  });

  // —— 新建潜次 + 新标记走通复核 ——
  await test("新潜次登记保存后可被标记选择，并能走通复核与闭潜", () => {
    const dom2 = boot(dump, uiDump);
    const w = dom2.window, dd = w.document;
    dd.querySelector("#newDiveBtn").click();
    const f = dd.querySelector("#diveForm").elements;
    f.code.value = "DIVE-03";
    f.plannedStart.value = "2026-09-21T08:00";
    f.plannedEnd.value = "2026-09-21T09:00";
    f.diver1.value = "甲";
    f.diver2.value = "乙";
    f.startPressure.value = "210";
    f.endPressure.value = "120";
    f.tideHeight.value = "0.5";
    f.actualExit.value = "2026-09-21T08:55";
    f.code.dispatchEvent(new w.Event("input"));
    dd.querySelector("#diveForm").dispatchEvent(new w.Event("submit"));
    check(dd.querySelector("#gate").className.includes("pass"), "新潜次应门槛通过");
    // 地图落点 + 选新潜次保存标记
    const rect = dd.querySelector("#map").getBoundingClientRect();
    dd.querySelector("#map").dispatchEvent(new w.MouseEvent("click", {
      bubbles: true, clientX: rect.left + 100, clientY: rect.top + 100
    }));
    const mf = dd.querySelector("#markForm").elements;
    const opts = $$(dd, "#markForm [name=diveId] option");
    const opt = opts.find(o => o.textContent.startsWith("DIVE-03"));
    check(!!opt, "新潜次应出现在标记所属下拉中");
    mf.diveId.value = opt.value;
    mf.code.value = "M-010";
    dd.querySelector("#markForm").dispatchEvent(new w.Event("submit"));
    // 选中新标记并复核
    const markers = $$(dd, "#map .marker");
    markers[markers.length - 1].click();
    const rv = dd.querySelector("#reviewer");
    rv.value = "丙";
    rv.dispatchEvent(new w.Event("input"));
    const cb = dd.querySelector("#exitChecked");
    cb.checked = true;
    cb.dispatchEvent(new w.Event("change"));
    check($$(dd, "#reviewBox .blockers li").length === 0, "新标记复核应无阻塞");
    dd.querySelector("#approveBtn").click();
    check(dd.querySelector("#reviewBox").className.includes("approved"), "新标记应通过复核");
    // 闭潜
    dd.querySelector("#closeDiveBtn").click();
    check(dd.querySelector("#diveSelect").selectedOptions[0].textContent.includes("已闭潜"),
      "应登记为已闭潜");
  });

  // —— 编辑标记不改变其地图坐标 ——
  await test("编辑已有标记只改字段，不改变地图坐标", () => {
    const dom2 = boot();
    const w = dom2.window, dd = w.document;
    const before = JSON.parse(w.localStorage.getItem("zfl30.diveLog.v2"));
    const target = before.marks.find(m => m.code === "A-017");
    $$(dd, "#map .marker").find(el =>
      el.style.left === target.x + "%" && el.style.top === target.y + "%").click();
    const mf = dd.querySelector("#markForm").elements;
    mf.note.value = "补充测量数据";
    dd.querySelector("#markForm").dispatchEvent(new w.Event("submit"));
    const after = JSON.parse(w.localStorage.getItem("zfl30.diveLog.v2"));
    const edited = after.marks.find(m => m.id === target.id);
    check(edited.x === target.x && edited.y === target.y, "坐标不应被编辑覆盖");
    check(edited.note === "补充测量数据", "字段改动应保存");
  });

  console.log(`\n界面冒烟测试全部通过：${passed} 项`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
