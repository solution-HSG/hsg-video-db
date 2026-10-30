/**
 * HSG 영상 DB → 구글 시트 자동 반영
 * 사이트에서 영상을 저장·삭제하면 아래 세 시트에 바로 반영합니다.
 *  1) 고객사용 시트  'H영상' 탭
 *  2) 영상리스트     'H_판매용영상' 탭 (P, C 탭은 건드리지 않음)
 *  3) 모듈리스트     'V.4' 탭 (제목만 적힌 메모 칸은 건드리지 않음)
 * 설치: 이 코드를 붙여넣고 [배포] > [새 배포] > 유형 '웹 앱',
 *       실행 사용자 '나', 액세스 권한 '모든 사용자'로 배포한 뒤 웹 앱 URL을 Claude에게 알려 주세요.
 */
const KEY = '여기에_연결키';  // 실제 키는 저장소에 올리지 않음
const CUSTOMER = { id: '1z7ltlknl_3K9qT8xP21Sq0TSO8S1e0yoCho7SNnANgM', tab: 'H영상' };
const LIST = { id: '1Q0Pw21zuVcmuwzhq1R-VrIhBUsllPqWZdYUeh6T_Y3s', tab: 'H_판매용영상', headerRow: 4 };
const MODS = { id: '10DiXJtkNstFBtdVqlbDPyi-XbJpVoM9RIoa6zERFR0U', tab: 'V.4' };

function doGet() {
  return out_({ ok: true, ready: true });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'bad_json' }); }
  if (body.key !== KEY) return out_({ ok: false, error: 'unauthorized' });
  const v = body.video || {};
  if (!v.code) return out_({ ok: false, error: 'no_code' });
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  const results = {}, errors = [];
  const run = (name, fn) => {
    try { results[name] = fn(); } catch (err) { errors.push(name + ': ' + err.message); }
  };
  try {
    if (body.op === 'remove') {
      run('customer', () => removeCustomer_(v));
      run('list', () => removeList_(v));
      run('modules', () => removeModules_(v));
    } else {
      run('customer', () => syncCustomer_(v, body.prevLink, body.prevTitle));
      run('list', () => syncList_(v, body.prevLink, body.prevTitle));
      run('modules', () => syncModules_(v));
    }
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
  return out_({ ok: errors.length === 0, results, errors });
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
const s_ = (x) => String(x == null ? '' : x).trim();

/* ---------- 1) 고객사용 시트 ---------- */
function customerSheet_() { return SpreadsheetApp.openById(CUSTOMER.id).getSheetByName(CUSTOMER.tab); }
function findCustomerRow_(rows, v, prevLink, prevTitle) {
  const find = (f) => rows.findIndex((r, i) => i > 0 && f(r));
  let i = v.link ? find((r) => s_(r[2]) === v.link) : -1;
  if (i < 0 && prevLink) i = find((r) => s_(r[2]) === prevLink);
  if (i < 0) i = find((r) => !s_(r[2]) && s_(r[0]) === v.code && s_(r[1]) === s_(v.title));
  if (i < 0 && prevTitle) i = find((r) => !s_(r[2]) && s_(r[0]) === v.code && s_(r[1]) === s_(prevTitle));
  return i;
}
function syncCustomer_(v, prevLink, prevTitle) {
  const sh = customerSheet_();
  const rows = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 3).getValues();
  let i = findCustomerRow_(rows, v, prevLink, prevTitle);
  const isNew = i < 0;
  if (isNew) {
    let last = rows.length;
    while (last > 1 && !rows[last - 1].some((c) => s_(c))) last--;
    i = last; // 0-based index of the new row
    const dest = sh.getRange(i + 1, 1, 1, 7);
    sh.getRange(2, 1, 1, 7).copyTo(dest, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    sh.getRange(2, 6).copyTo(sh.getRange(i + 1, 6), SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
  }
  const used = v.status === '사용';
  const row = sh.getRange(i + 1, 1, 1, 7);
  row.setBackground(used ? null : '#d9d9d9');
  sh.getRange(i + 1, 1, 1, 2).setFontLine(used ? 'none' : 'line-through');
  row.setValues([[v.code, v.title || '', v.link || '', v.sheetModule || '', v.duration || '', used ? 'O' : 'X', used ? '' : (v.remark || '')]]);
  return (isNew ? '추가 ' : '수정 ') + (i + 1) + '행';
}
function removeCustomer_(v) {
  const sh = customerSheet_();
  const rows = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 3).getValues();
  const i = rows.findIndex((r, k) => k > 0 && (v.link ? s_(r[2]) === v.link : (!s_(r[2]) && s_(r[0]) === v.code && s_(r[1]) === s_(v.title))));
  if (i < 0) return '해당 줄 없음';
  sh.deleteRow(i + 1);
  return '삭제 ' + (i + 1) + '행';
}

/* ---------- 2) 영상리스트 (H_판매용영상) ---------- */
// 열 번호 (B=2 … U=21)
const L = { code: 2, perf: 3, d1: 4, d2: 5, d3: 6, module: 7, topic: 8, title: 9, review: 10, link: 11, line: 12, inst: 13, maker: 14, dur: 15, date: 16, tool: 17, note: 21 };
function listSheet_() { return SpreadsheetApp.openById(LIST.id).getSheetByName(LIST.tab); }
function findListRow_(sh, v, prevLink, prevTitle) {
  const h = LIST.headerRow;
  const n = Math.max(sh.getLastRow() - h, 0);
  const rows = n ? sh.getRange(h + 1, 1, n, 21).getValues() : [];
  const find = (f) => rows.findIndex(f);
  let i = v.link ? find((r) => s_(r[L.link - 1]) === v.link) : -1;
  if (i < 0 && prevLink) i = find((r) => s_(r[L.link - 1]) === prevLink);
  if (i < 0) i = find((r) => s_(r[L.code - 1]) === v.code && s_(r[L.title - 1]) === s_(v.title));
  if (i < 0 && prevTitle) i = find((r) => s_(r[L.code - 1]) === v.code && s_(r[L.title - 1]) === s_(prevTitle));
  if (i < 0) {
    const same = rows.map((r, k) => k).filter((k) => s_(rows[k][L.code - 1]) === v.code && !s_(rows[k][L.link - 1]));
    if (same.length === 1) i = same[0];
  }
  let last = rows.length;
  while (last > 0 && !s_(rows[last - 1][L.code - 1])) last--;
  return { row: i < 0 ? -1 : h + 1 + i, nextRow: h + 1 + last };
}
function syncList_(v, prevLink, prevTitle) {
  const sh = listSheet_();
  const f = findListRow_(sh, v, prevLink, prevTitle);
  const isNew = f.row < 0;
  const r = isNew ? f.nextRow : f.row;
  if (isNew && r > LIST.headerRow + 1) {
    sh.getRange(r - 1, 1, 1, 21).copyTo(sh.getRange(r, 1, 1, 21), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  }
  const put = (col, val) => { if (s_(val) !== '') sh.getRange(r, col).setValue(val); };
  put(L.code, v.code);
  const cat = s_(v.category).split('/').map(s_).filter(Boolean);
  if (cat.length === 4) { put(L.d1, cat[0]); put(L.d2, cat[1]); put(L.d3, cat[2]); put(L.topic, cat[3]); }
  if (Array.isArray(v.related) && v.related.length) put(L.perf, v.related.join(', '));
  put(L.module, v.sheetModule);
  put(L.title, v.title);
  if (v.review === true) put(L.review, 'O');
  put(L.link, v.link);
  put(L.line, v.summaryLine);
  put(L.inst, v.instructor);
  put(L.maker, v.maker);
  put(L.dur, v.duration);
  put(L.date, v.date);
  put(L.tool, v.tool);
  put(L.note, v.note);
  return (isNew ? '추가 ' : '수정 ') + r + '행';
}
function removeList_(v) {
  const sh = listSheet_();
  const f = findListRow_(sh, v, null, null);
  if (f.row < 0) return '해당 줄 없음';
  sh.deleteRow(f.row);
  return '삭제 ' + f.row + '행';
}

/* ---------- 3) 모듈리스트 (V.4) ---------- */
// 1행 강의명(모듈 이름), 2행 개수, 3행부터 'n)제목' 줄과 'n' 내용 줄이 번갈아 나옴
function modsGrid_() {
  const sh = SpreadsheetApp.openById(MODS.id).getSheetByName(MODS.tab);
  const lastRow = Math.max(sh.getLastRow(), 2), lastCol = Math.max(sh.getLastColumn(), 3);
  const vals = sh.getRange(1, 1, lastRow, lastCol).getValues();
  const titleRows = [];
  for (let r = 2; r < vals.length; r++) if (/^\d+\)\s*제목$/.test(s_(vals[r][0]))) titleRows.push(r); // 0-based
  return { sh, vals, titleRows };
}
const norm_ = (x) => s_(x).replace(/\s+/g, '');
function findModCol_(vals, name) {
  const row = vals[0];
  for (let c = 1; c < row.length; c++) if (norm_(row[c]) === norm_(name)) return c;
  return -1;
}
const tag_ = (code) => '[' + code + ']';
function updateCount_(g, c) {
  const cell = g.sh.getRange(2, c + 1);
  if (cell.getFormula()) return;
  const n = g.titleRows.filter((r) => s_(g.vals[r][c]).startsWith('[')).length;
  cell.setValue(n);
}
function clearCode_(g, code, keepCols) {
  let n = 0;
  for (let c = 1; c < g.vals[0].length; c++) {
    if (keepCols.indexOf(c) >= 0) continue;
    for (const r of g.titleRows) {
      if (s_(g.vals[r][c]).startsWith(tag_(code))) {
        g.sh.getRange(r + 1, c + 1, 2, 1).clearContent();
        g.vals[r][c] = ''; if (g.vals[r + 1]) g.vals[r + 1][c] = '';
        updateCount_(g, c);
        n++;
      }
    }
  }
  return n;
}
function syncModules_(v) {
  const g = modsGrid_();
  const names = s_(v.sheetModule).split(',').map(s_).filter(Boolean);
  const cols = [], notes = [];
  for (const name of names) {
    const c = findModCol_(g.vals, name);
    if (c < 0) { notes.push("'" + name + "' 열 없음"); continue; }
    cols.push(c);
    const title = tag_(v.code) + ' ' + (v.title || '');
    let r = g.titleRows.find((tr) => s_(g.vals[tr][c]).startsWith(tag_(v.code)));
    let added = false;
    if (r === undefined) {
      r = g.titleRows.find((tr) => !s_(g.vals[tr][c]) && !s_(g.vals[tr + 1] ? g.vals[tr + 1][c] : ''));
      if (r === undefined) {
        const lastT = g.titleRows.length ? g.titleRows[g.titleRows.length - 1] : 1;
        r = lastT + 2;
        const n = g.titleRows.length + 1;
        if (!s_(g.sh.getRange(r + 1, 1).getValue())) g.sh.getRange(r + 1, 1, 2, 1).setValues([[n + ')제목'], [String(n)]]);
        g.titleRows.push(r);
        while (g.vals.length < r + 2) g.vals.push(new Array(g.vals[0].length).fill(''));
      }
      added = true;
    }
    g.sh.getRange(r + 1, c + 1, 2, 1).setValues([[title], [v.summary || '']]);
    g.vals[r][c] = title; g.vals[r + 1][c] = v.summary || '';
    if (added) updateCount_(g, c);
    notes.push(name + (added ? ' 추가' : ' 수정'));
  }
  const removed = clearCode_(g, v.code, cols);
  if (removed) notes.push('이전 모듈 ' + removed + '곳 비움');
  return notes.join(', ') || '모듈 없음';
}
function removeModules_(v) {
  const g = modsGrid_();
  const n = clearCode_(g, v.code, []);
  return n ? n + '곳 비움' : '해당 칸 없음';
}
