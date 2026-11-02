// 비메오 영상에서 장면을 뽑아 Claude가 '강사 얼굴 정면샷' 1장과 '디자인된 자막 샷' 1장을 고르는 함수
// 호출: { token, id: "H065", apply: false|true, n: 10 }
// apply=false 이면 미리보기(후보와 선택 결과만 저장), true 이면 영상의 thumb/thumb2를 교체
import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = "claude-sonnet-5-5";
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const VT = () => Deno.env.get("VIMEO_TOKEN") || "";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

async function vimeo(path: string, init: RequestInit = {}) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch("https://api.vimeo.com" + path, {
      ...init,
      headers: { authorization: "bearer " + VT(), accept: "application/vnd.vimeo.*+json;version=3.4", "content-type": "application/json", ...(init.headers || {}) },
    });
    if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 5000 * (i + 1))); continue; }
    return r;
  }
  throw new Error("vimeo rate limited");
}
const vimeoId = (link: string) => (String(link).match(/vimeo\.com\/(?:video\/)?(\d+)/) || [])[1] || "";
const pick = (sizes: any[], w: number) => {
  const s = [...(sizes || [])].sort((a, b) => a.width - b.width);
  return (s.find((x) => x.width >= w) || s[s.length - 1])?.link || "";
};
async function getBytes(url: string) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch(url);
    if (r.ok) {
      const b = new Uint8Array(await r.arrayBuffer());
      if (b.length > 2000) return b;
    }
    await new Promise((ok) => setTimeout(ok, 1500));
  }
  return null;
}
const b64 = (b: Uint8Array) => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };

// 영상 길이를 n구간으로 나눠 구간마다 무작위 1곳 (앞 8%, 뒤 6%는 타이틀·엔딩이라 제외)
function times(duration: number, n: number) {
  const a = Math.max(8, duration * 0.08), z = duration - Math.max(6, duration * 0.06);
  const span = Math.max(1, z - a), out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Math.round((a + span * (i + Math.random()) / n) * 10) / 10);
  // 마무리 요약 화면이 나오는 뒷부분(80~97%)에서 2곳 더
  for (let i = 0; i < 2; i++) out.push(Math.round(duration * (0.8 + 0.17 * (i + Math.random()) / 2) * 10) / 10);
  return out;
}

const PROMPT = (title: string, n: number) => `다음은 HSG 교육 영상 "${title}"에서 뽑은 장면 ${n}장이다 (0번부터 순서대로).
두 장을 골라라.
1) face: 강사 얼굴이 정면(또는 거의 정면)으로 크고 선명하게 보이는 장면. 눈을 감았거나, 입이 크게 벌어졌거나, 흔들렸거나, 얼굴이 작거나 옆모습인 장면은 제외.
2) caption: 사람이 전혀 나오지 않고, 영상 내용을 요약·정리한 화면 — 핵심 문장, 키워드, 요약 항목이 큰 글씨로 여러 개 보여 화면만 봐도 무슨 내용인지 알 수 있는 장면. 마무리 요약 화면이 있으면 우선. 그래프·도표는 설명 문장이나 키워드가 함께 크게 적혀 있을 때만 가능하고, 축 이름만 있는 빈 그래프는 제외. 화면에 사람(강사의 일부나 작은 모습 포함)이 조금이라도 보이면 제외. 영상 시작 타이틀 화면, 질문 한 줄만 있는 화면, 빈 화면, 글자가 작은 화면, 전환 중인 흐린 화면도 제외. 후보가 여럿이면 글자가 더 크고 내용이 더 많이 요약된 장면을 고른다.
알맞은 장면이 없으면 null.
JSON 하나로만 답하라: {"face":번호 또는 null,"faceNote":"짧은 이유","caption":번호 또는 null,"captionNote":"짧은 이유"}`;

const CAP_PROMPT = (title: string, n: number) => PROMPT(title, n)
  .replace("두 장을 골라라.", "이번에는 caption 한 장만 골라라. face는 항상 null로 둔다.");

async function claude(title: string, imgs: Uint8Array[], prompt = PROMPT) {
  const content: any[] = [];
  imgs.forEach((b, i) => {
    content.push({ type: "text", text: `${i}번` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64(b) } });
  });
  content.push({ type: "text", text: prompt(title, imgs.length) });
  const send = (extra: Record<string, unknown>) => fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY") || "", "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, messages: [{ role: "user", content }], ...extra }),
  });
  // 생각 단계 없이 바로 답하게 함 (지원하지 않으면 기본 설정으로 다시 요청)
  let r = await send({ thinking: { type: "disabled" } });
  if (r.status === 400) r = await send({});
  const j = await r.json();
  if (!r.ok) throw new Error("claude " + r.status + " " + JSON.stringify(j).slice(0, 200));
  const t = (j.content || []).map((c: any) => c.text || "").join("");
  const m = t.match(/\{[\s\S]*\}/);
  const out = m ? JSON.parse(m[0]) : {};
  return { ...out, usage: j.usage };
}

Deno.serve(async (req) => {
  const body = await req.json().catch(() => ({}));
  const { data: sec } = await sb.from("app_secrets").select("value").eq("name", "THUMB_TOKEN").maybeSingle();
  if (!sec || body.token !== sec.value) return json({ error: "unauthorized" }, 401);
  if (!VT()) return json({ error: "VIMEO_TOKEN 없음" }, 503);

  const id = String(body.id || "");
  const { data: row } = await sb.from("docs").select("data").eq("col", "videos").eq("id", id).maybeSingle();
  if (!row) return json({ id, error: "영상 없음" }, 404);
  const v = row.data;
  const vid = vimeoId(v.link);
  if (!vid) return json({ id, error: "비메오 링크 없음" });

  const info = await vimeo(`/videos/${vid}?fields=duration,name`);
  if (!info.ok) return json({ id, error: "비메오 영상 정보 " + info.status, detail: (await info.text()).slice(0, 200) });
  const { duration } = await info.json();
  const n = Math.min(Math.max(Number(body.n) || 10, 4), 12);  // 여기에 뒷부분 2곳이 더해짐
  const ts = times(Number(duration) || 300, n);
  const started = Date.now();

  // 1) 장면 이미지 만들기 (비메오 대표 썸네일은 바꾸지 않음: active=false)
  const pics: { t: number; uri: string; small: string; big: string }[] = [];
  const frames = async (list: number[]) => {
    const got: { p: typeof pics[number]; b: Uint8Array }[] = [];
    for (const t of list) {
      const r = await vimeo(`/videos/${vid}/pictures`, { method: "POST", body: JSON.stringify({ time: t, active: false }) });
      if (!r.ok) { const e = await r.text(); if (!pics.length && r.status >= 400 && r.status < 500) throw new Error("장면 만들기 실패 " + r.status + " " + e.slice(0, 200)); continue; }
      const j = await r.json();
      const p = { t, uri: j.uri, small: pick(j.sizes, 640), big: pick(j.sizes, 1280) };
      pics.push(p);
      const b = await getBytes(p.small);
      if (b) got.push({ p, b });
    }
    return got;
  };
  try {
    const first = await frames(ts);
    const smalls = first.map((x) => x.b), keep = first.map((x) => x.p);
    if (!smalls.length) return json({ id, error: "장면 이미지를 받지 못함" });

    // 2) Claude 판정
    const ai = await claude(v.title || id, smalls);
    const pickIdx = (k: number | null) => (Number.isInteger(k) && k! >= 0 && k! < keep.length ? k! : null);
    const fi = pickIdx(ai.face);
    let ci = pickIdx(ai.caption), capNote = ai.captionNote, extraUsage = 0, rounds = 0;
    while (ci === null && rounds < 2 && Date.now() - started < 80_000) {
      rounds++;
      const more = await frames(times(Number(duration) || 300, 8).map((t) => t + (rounds * 3.7)));
      if (!more.length) break;
      const r2 = await claude(v.title || id, more.map((x) => x.b), CAP_PROMPT);
      extraUsage += (r2.usage?.input_tokens || 0) + (r2.usage?.output_tokens || 0) * 5;
      const k = Number.isInteger(r2.caption) && r2.caption >= 0 && r2.caption < more.length ? r2.caption : null;
      capNote = r2.captionNote || capNote;
      if (k !== null) { smalls.push(more[k].b); keep.push(more[k].p); ci = keep.length - 1; }
    }

    // 3) 고른 장면 저장
    const save = async (i: number | null, name: string) => {
      if (i === null) return "";
      const b = await getBytes(keep[i].big) || smalls[i];
      const path = `t/${name}.jpg`;
      const { error } = await sb.storage.from("files").upload(path, b, { contentType: "image/jpeg", upsert: true });
      if (error) throw error;
      return path;
    };
    const stamp = Date.now().toString(36);
    const safe = id.replace(/[^A-Za-z0-9_-]/g, "_");
    let candidates: string[] = [];
    if (!body.apply) {
      // 미리보기: 후보 전부 저장
      candidates = [];
      for (let i = 0; i < smalls.length; i++) {
        const path = `t/pv_${safe}_${i}.jpg`;
        await sb.storage.from("files").upload(path, smalls[i], { contentType: "image/jpeg", upsert: true });
        candidates.push(path);
      }
    }
    const facePath = await save(fi, body.apply ? `${safe}_f_${stamp}` : `pv_${safe}_face`);
    const capPath = await save(ci, body.apply ? `${safe}_c_${stamp}` : `pv_${safe}_cap`);

    let applied = false;
    if (body.apply) {
      const old = [v.thumb, v.thumb2].filter((x: string) => x && /^t\//.test(x));
      const patch = { thumb: facePath, thumb2: capPath, thumbAuto: { at: new Date().toISOString(), faceT: fi !== null ? keep[fi].t : null, capT: ci !== null ? keep[ci].t : null } };
      const { error } = await sb.rpc("docs_merge", { p_col: "videos", p_id: id, p_patch: patch });
      if (error) throw error;
      const drop = old.filter((p: string) => p !== facePath && p !== capPath);
      if (drop.length) await sb.storage.from("files").remove(drop);
      applied = true;
    }
    return json({ id, ok: true, applied, duration, times: keep.map((p) => p.t), face: fi, caption: ci, faceNote: ai.faceNote, captionNote: capNote, rounds, extraUsage, facePath, capPath, candidates, usage: ai.usage });
  } catch (e) {
    return json({ id, error: String((e as Error)?.message || e).slice(0, 300) });
  } finally {
    // 4) 비메오에 만든 장면 이미지 정리
    for (const p of pics) { if (p.uri) await vimeo(p.uri, { method: "DELETE" }).catch(() => null); }
  }
});
