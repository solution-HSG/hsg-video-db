/* HSG 영상 DB 런타임: Supabase(데이터·파일)와 서버 함수(쓰기·AI·시트)를 사이트 코드가 쓰던 방식 그대로 제공 */
(() => {
const CFG = {
  url: 'https://kpxhljkpvicffkxcvkeh.supabase.co',
  key: 'sb_publishable_0pBJQyG8r6z_5MFC6X1CdA_Ym5t578m',
};
const MODE = window.HSG_MODE === 'admin' ? 'admin' : 'staff';
const FN = CFG.url + '/functions/v1/api';
const LS = 'hsg_admin_key';
const sb = window.supabase.createClient(CFG.url, CFG.key, { auth: { persistSession: false } });
const lsGet = k => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const lsSet = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} };

const HSG = window.HSG = {
  mode: MODE,
  admin: false,
  storage: CFG.url + '/storage/v1/object/public/files/',
  thumbUrl: p => p && /^t\//.test(p) ? CFG.url + '/storage/v1/object/public/files/' + p : '',
};

async function call(action, body = {}, opts = {}) {
  const headers = { 'content-type': 'application/json', apikey: CFG.key, authorization: 'Bearer ' + CFG.key };
  const k = lsGet(LS);
  if (k) headers['x-admin-key'] = k;
  let r;
  try {
    r = await fetch(FN, { method: 'POST', headers, body: JSON.stringify({ action, ...body }), signal: opts.signal });
  } catch (e) {
    if (e?.name === 'AbortError') throw { code: 'cancelled' };
    throw { code: 'network', message: '서버에 연결하지 못했습니다' };
  }
  if (opts.raw) return r;
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const code = j.error?.code || 'server_error';
    if (code === 'unauthorized') { HSG.admin = false; window.dispatchEvent(new Event('hsg-auth')); throw { code: 'invalid_argument', message: j.error.message }; }
    throw { code, message: j.error?.message || '' };
  }
  return j;
}
HSG.call = call;

HSG.login = async pw => {
  lsSet(LS, pw);
  const j = await call('check').catch(() => ({ admin: false }));
  HSG.admin = !!j.admin;
  if (!HSG.admin) lsSet(LS, '');
  return HSG.admin;
};
HSG.logout = () => { lsSet(LS, ''); HSG.admin = false; };
HSG.checkStored = async () => {
  if (!lsGet(LS)) return false;
  const j = await call('check').catch(() => ({ admin: false }));
  HSG.admin = !!j.admin;
  if (!HSG.admin) lsSet(LS, '');
  return HSG.admin;
};

/* ---------- db: 기존 claude.use('db')와 같은 모양 ---------- */
const snap = rows => ({ docs: rows.map(r => ({ id: r.id, data: () => r.data })) });
const subs = {};   // col -> Set({emit, refetch})
const cache = {};  // col -> Map(id -> data)  (마지막으로 받은 목록)
function emitLocal(col) {
  const m = cache[col]; if (!m) return;
  const rows = [...m].map(([id, data]) => ({ id, data }));
  (subs[col] || new Set()).forEach(s => s.emit(rows));
}
// 저장 직후 화면에 바로 반영(낙관적 갱신)한 뒤, 서버 목록을 다시 받아 맞춤
function local(col, fn) {
  if (cache[col]) { fn(cache[col]); emitLocal(col); }
  (subs[col] || new Set()).forEach(s => s.refetch());
}
async function fetchCol(col) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('docs').select('id,data').eq('col', col).range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}
function collection(col, filters = []) {
  return {
    limit() { return collection(col, filters); },
    where(f, op, v) { return collection(col, [...filters, [f, op, v]]); },
    async get() {
      let q = sb.from('docs').select('id,data').eq('col', col);
      for (const [f, , v] of filters) q = q.eq('data->>' + f, String(v));
      const { data, error } = await q;
      if (error) throw error;
      return snap(data);
    },
    async add(data) { const j = await call('add', { col, data }); local(col, m => m.set(j.id, data)); return { id: j.id }; },
    onSnapshot(cb, err) {
      let timer = null, alive = true;
      const load = async () => {
        try {
          const rows = await fetchCol(col);
          cache[col] = new Map(rows.map(r => [r.id, r.data]));
          if (alive) cb(snap(rows));
        } catch (e) { if (alive && err) err(e); }
      };
      const sub = { emit: rows => alive && cb(snap(rows)), refetch: () => { clearTimeout(timer); timer = setTimeout(load, 400); } };
      (subs[col] ||= new Set()).add(sub);
      load();
      const ch = sb.channel('docs-' + col + '-' + Math.random().toString(36).slice(2))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'docs', filter: 'col=eq.' + col }, sub.refetch)
        .subscribe();
      return () => { alive = false; subs[col].delete(sub); sb.removeChannel(ch); };
    },
  };
}
function doc(path) {
  const [col, id] = path.split('/');
  return {
    async get() {
      const { data, error } = await sb.from('docs').select('id,data').eq('col', col).eq('id', id).maybeSingle();
      if (error) throw error;
      return { exists: !!data, id, data: () => data ? data.data : undefined };
    },
    async set(data) { await call('set', { col, id, data }); local(col, m => m.set(id, JSON.parse(JSON.stringify(data)))); },
    async update(data) { await call('update', { col, id, data }); local(col, m => { if (m.has(id)) m.set(id, { ...m.get(id), ...JSON.parse(JSON.stringify(data)) }); }); },
    async delete() { await call('delete', { col, id }); local(col, m => m.delete(id)); },
  };
}
const db = { doc, collection: c => collection(c) };

/* ---------- AI: 기존 sample.json과 같은 모양 ---------- */
function parseJson(t) {
  t = String(t || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch {}
  const a = Math.min(...['{', '['].map(c => { const i = t.indexOf(c); return i < 0 ? Infinity : i; }));
  const b = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (a < Infinity && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  throw { code: 'invalid_json' };
}
const sample = {
  async json(prompt, opts = {}) {
    const r = await call('ai', { prompt, maxTokens: opts.maxTokens || 16000 }, { raw: true, signal: opts.signal });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw { code: j.error?.code || 'ai_error', message: j.error?.message || '' };
    }
    const reader = r.body.getReader(), dec = new TextDecoder();
    let text = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
        if (opts.onText) { try { opts.onText({ text }); } catch {} }
      }
    } catch (e) {
      if (opts.signal?.aborted) throw { code: 'cancelled' };
      throw { code: 'ai_error' };
    }
    const k = text.indexOf('\u0000ERROR:');
    if (k >= 0) throw { code: /overloaded|rate/.test(text.slice(k)) ? 'rate_limited' : 'ai_error' };
    if (!text.trim()) throw { code: 'empty_completion' };
    return parseJson(text);
  },
};

/* ---------- 파일(썸네일) ---------- */
const toB64 = blob => new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(',')[1]); fr.onerror = no; fr.readAsDataURL(blob); });
const assets = {
  async upload(blob, o = {}) { const j = await call('upload', { b64: await toB64(blob), type: o.type || blob.type }); return { id: j.id }; },
  async delete(id) { if (/^t\//.test(id || '')) await call('unlink', { id }); },
};

/* ---------- 내려받기 ---------- */
const downloads = {
  async save({ filename, data }) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  },
};

const user = {
  async id() { return HSG.admin ? 'admin' : 'staff'; },
  async can() { return HSG.admin; },
  async me() { return { name: HSG.admin ? '관리자' : '' }; },
  async profiles() { return {}; },
};

window.claude = {
  async use(name) {
    if (name === 'db') return db;
    if (name === 'sample') return sample;
    if (name === 'assets') return assets;
    if (name === 'downloads') return downloads;
    if (name === 'user') return user;
    return null;
  },
};
})();
