// HSG 영상 DB 서버 함수
// - 읽기는 누구나 (사이트가 Supabase에서 직접 읽음)
// - 쓰기·파일·시트 반영은 관리자 비밀번호(x-admin-key)가 있어야 함
// - AI(Claude API)는 카달로그 만들기에 쓰므로 누구나 호출 가능
import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = "claude-sonnet-5-5";
const BUCKET = "files";
const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-admin-key, authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "content-type": "application/json" } });
const fail = (code: string, message = "", status = 400) => json({ error: { code, message } }, status);

let kv: Record<string, string> | null = null;
let kvAt = 0;
async function conf() {
  if (!kv || Date.now() - kvAt > 60_000) {
    const { data } = await sb.from("app_secrets").select("name,value");
    kv = Object.fromEntries((data || []).map((r: { name: string; value: string }) => [r.name, r.value]));
    kvAt = Date.now();
  }
  return kv!;
}
function safeEq(a: string, b: string) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}
async function isAdmin(req: Request) {
  const k = req.headers.get("x-admin-key") || "";
  if (!k) return false;
  const pw = Deno.env.get("ADMIN_PASSWORD");
  if (pw && safeEq(k, pw)) return true;
  const c = await conf();
  if (c.MIGRATE_TOKEN && safeEq(k, c.MIGRATE_TOKEN)) return true;
  await new Promise((r) => setTimeout(r, 600));
  return false;
}
const COLS = new Set(["videos", "modules", "mlinks", "instructors", "settings", "history"]);
const okCol = (c: unknown) => typeof c === "string" && COLS.has(c);
const okId = (i: unknown) => typeof i === "string" && /^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(i);
const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(15)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");

async function ai(body: { prompt?: string; maxTokens?: number }) {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return fail("ai_not_configured", "ANTHROPIC_API_KEY가 없습니다", 503);
  const prompt = String(body.prompt || "");
  if (!prompt || prompt.length > 400_000) return fail("invalid_argument", "prompt");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: Math.min(Number(body.maxTokens) || 16000, 32000),
      stream: true,
      system: "요청에 맞는 JSON 하나만 출력한다. 코드 블록이나 설명 문장 없이 JSON만 쓴다.",
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!r.ok || !r.body) {
    const t = await r.text().catch(() => "");
    return fail(r.status === 429 || r.status === 529 ? "rate_limited" : "ai_error", t.slice(0, 300), 502);
  }
  const dec = new TextDecoder(), enc = new TextEncoder();
  const reader = r.body.getReader();
  const stream = new ReadableStream({
    async start(ctl) {
      let buf = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith("data:")) continue;
            try {
              const ev = JSON.parse(line.slice(5));
              if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") ctl.enqueue(enc.encode(ev.delta.text));
              if (ev.type === "error") ctl.enqueue(enc.encode("\u0000ERROR:" + (ev.error?.type || "ai_error")));
            } catch { /* 무시 */ }
          }
        }
      } catch {
        ctl.enqueue(enc.encode("\u0000ERROR:ai_error"));
      }
      ctl.close();
    },
  });
  return new Response(stream, { headers: { ...CORS, "content-type": "text/plain; charset=utf-8" } });
}

async function sheet(body: { payload?: Record<string, unknown> }) {
  const c = await conf();
  if (!c.SHEET_HOOK_URL) return fail("sheet_not_configured", "시트 연결 주소가 아직 없습니다", 503);
  const r = await fetch(c.SHEET_HOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...(body.payload || {}), key: c.SHEET_HOOK_KEY }),
    redirect: "follow",
  });
  const t = await r.text();
  try {
    return json(JSON.parse(t), r.ok ? 200 : 502);
  } catch {
    return fail("sheet_error", t.slice(0, 300), 502);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail("method", "", 405);
  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return fail("invalid_argument", "json");
  }
  const a = body.action;
  try {
    if (a === "ai") return await ai(body);
    if (a === "ping") {
      const { count } = await sb.from("docs").select("*", { count: "exact", head: true });
      return json({ ok: true, docs: count });
    }
    const admin = await isAdmin(req);
    if (a === "check") return json({ admin });
    if (!admin) return fail("unauthorized", "관리자 비밀번호가 필요합니다", 401);

    if (a === "set") {
      if (!okCol(body.col) || !okId(body.id)) return fail("invalid_argument", "path");
      const { error } = await sb.from("docs").upsert({ col: body.col, id: body.id, data: body.data || {}, updated_at: new Date().toISOString() });
      if (error) throw error;
      return json({ ok: true });
    }
    if (a === "add") {
      if (!okCol(body.col)) return fail("invalid_argument", "path");
      const id = rid();
      const { error } = await sb.from("docs").insert({ col: body.col, id, data: body.data || {} });
      if (error) throw error;
      return json({ ok: true, id });
    }
    if (a === "update") {
      if (!okCol(body.col) || !okId(body.id)) return fail("invalid_argument", "path");
      const { data, error } = await sb.rpc("docs_merge", { p_col: body.col, p_id: body.id, p_patch: body.data || {} });
      if (error) throw error;
      if (!data) return fail("not_found", "문서가 없습니다", 404);
      return json({ ok: true });
    }
    if (a === "delete") {
      if (!okCol(body.col) || !okId(body.id)) return fail("invalid_argument", "path");
      const { error } = await sb.from("docs").delete().eq("col", body.col).eq("id", body.id);
      if (error) throw error;
      return json({ ok: true });
    }
    if (a === "bulk") {
      const rows = (body.docs || []).filter((d: any) => okCol(d.col) && okId(d.id))
        .map((d: any) => ({ col: d.col, id: d.id, data: d.data || {}, updated_at: new Date().toISOString() }));
      const { error } = await sb.from("docs").upsert(rows);
      if (error) throw error;
      return json({ ok: true, count: rows.length });
    }
    if (a === "upload") {
      const bytes = Uint8Array.from(atob(String(body.b64 || "")), (ch) => ch.charCodeAt(0));
      if (!bytes.length || bytes.length > 10 * 1024 * 1024) return fail("invalid_argument", "file");
      const type = String(body.type || "application/octet-stream");
      const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : type.startsWith("image/") ? "jpg" : "bin";
      const path = (typeof body.name === "string" && /^t\/[A-Za-z0-9_\-]{1,80}\.(jpg|png|webp)$/.test(body.name))
        ? body.name : `t/${crypto.randomUUID()}.${ext}`;
      const { error } = await sb.storage.from(BUCKET).upload(path, bytes, { contentType: type, upsert: true });
      if (error) throw error;
      return json({ ok: true, id: path });
    }
    if (a === "unlink") {
      const p = String(body.id || "");
      if (!/^t\/[A-Za-z0-9_\-]{1,80}\.(jpg|png|webp)$/.test(p)) return fail("invalid_argument", "id");
      await sb.storage.from(BUCKET).remove([p]);
      return json({ ok: true });
    }
    if (a === "sheet") return await sheet(body);
    return fail("invalid_argument", "action");
  } catch (e) {
    return fail("server_error", String((e as Error)?.message || e).slice(0, 300), 500);
  }
});
