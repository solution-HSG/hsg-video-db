#!/usr/bin/env python3
"""src/app.html(기존 Claude 사이트 원본) + src/runtime.js → index.html(직원용), admin/index.html(관리자용)"""
import pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
src = (ROOT / 'src/app.html').read_text(encoding='utf-8')
runtime = (ROOT / 'src/runtime.js').read_text(encoding='utf-8')


def rep(s, old, new, count=1):
    n = s.count(old)
    if n != count:
        sys.exit(f'replace failed ({n}x): {old[:80]!r}')
    return s.replace(old, new)


def rep_between(s, start, end, new):
    a = s.find(start)
    b = s.find(end, a)
    if a < 0 or b < 0:
        sys.exit(f'block not found: {start[:60]!r}')
    return s[:a] + new + s[b:]


s = src
# 1) 문서 머리
s = rep(s, '<title>HSG 영상 DB</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n',
        '<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        '<meta name="robots" content="noindex, nofollow">\n'
        '<title>HSG 영상 DB</title>\n')

# 2) 썸네일 주소
s = rep(s, "const thumbUrl = v => v && v.thumb ? '/_blob/'+v.thumb : '';",
        "const thumbUrl = v => v && v.thumb ? HSG.thumbUrl(v.thumb) : '';")
s = rep(s, '<div class="cv-tile img"><img src="${thumbUrl(x.v)}" alt=""></div>',
        '<div class="cv-tile img"><img src="${thumbUrl(x.v)}" alt="" crossorigin="anonymous"></div>')
s = rep(s, '${v.thumb?`<img src="${thumbUrl(v)}" alt="">`:`<span class="dt-code">',
        '${v.thumb?`<img src="${thumbUrl(v)}" alt="" crossorigin="anonymous">`:`<span class="dt-code">')
s = rep(s, "{scale:1.6, backgroundColor:'#ffffff', logging:false,",
        "{scale:1.6, backgroundColor:'#ffffff', logging:false, useCORS:true,")

# 3) Claude 전용 안내 문구
s = rep(s, '이 화면에서는 데이터 저장소에 연결할 수 없습니다. claude.ai에 로그인한 상태로 이 페이지를 열어 주세요.',
        '데이터 저장소에 연결하지 못했습니다. 잠시 후 새로고침해 주세요.')
s = rep(s, "이 화면에서는 AI 기능을 쓸 수 없습니다. claude.ai에 로그인한 상태로 열어 주세요.",
        "AI 기능에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.")
s = rep(s, "e?.code==='not_granted' ? 'AI 사용이 허용되지 않았습니다. 페이지의 권한 메뉴에서 허용한 뒤 다시 시도해 주세요.'",
        "e?.code==='ai_not_configured' ? 'AI 설정(API 키)이 아직 없습니다. 관리자에게 알려 주세요.'")
s = rep(s, "이 페이지는 보기 전용으로 열려 있어 등록할 수 없습니다. 담당자에게 편집 권한을 요청해 주세요.",
        "관리자 비밀번호로 로그인해야 등록할 수 있습니다.")
s = rep(s, "toast('편집 권한이 없어 저장하지 못했습니다');",
        "toast('관리자 로그인이 풀려 저장하지 못했습니다. 다시 로그인해 주세요.'); showLogin();")

# 4) 구글 시트 반영: 서버 함수 → Apps Script (시트 3개)
SHEET_NEW = r'''/* ---------- Google Sheet sync (고객사용 시트·영상리스트·모듈리스트) ---------- */
function sheetErr(e){
  if (e?.code==='sheet_not_configured') return '구글 시트 반영 실패: 시트 연결 주소가 아직 설정되지 않았습니다';
  if (e?.code==='sheet') return '구글 시트 반영 실패: '+String(e.message||'').slice(0,90);
  if (e?.code==='invalid_argument') return '구글 시트 반영 실패: 관리자 로그인이 필요합니다';
  return '구글 시트 반영 실패: 영상 상세의 "다시 반영"으로 다시 시도해 주세요';
}
const SHEET_LABEL = {customer:'고객사용', list:'영상리스트', modules:'모듈리스트'};
async function sheetCall(payload){
  const r = await HSG.call('sheet', {payload});
  if (!r.ok) throw {code:'sheet', message:(r.errors||[]).map(x=>{ const [k,...m]=String(x).split(': '); return (SHEET_LABEL[k]||k)+' '+m.join(': '); }).join(' / ') || r.error || '시트가 요청을 거절했습니다'};
  return Object.entries(r.results||{}).map(([k,m])=>(SHEET_LABEL[k]||k)+' '+m).join(' · ');
}
const sheetVideo = v => ({code:v.code, title:v.title||'', link:v.link||'', sheetModule:v.sheetModule||'', duration:fmtDur(v.duration)||v.duration||'',
  status:v.status||'', remark:v.remark||'', summary:v.summary||'', summaryLine:v.summaryLine||'', instructor:v.instructor||'', maker:v.maker||'',
  date:v.date||'', tool:v.tool||'', note:v.note||'', review:!!v.review, category:v.category||'', related:v.related||[]});
async function runSync(id, v, prevLink, prevTitle, label){
  const pre = label ? label+' · ' : '';
  const cur = () => S.videos.find(x=>x.id===id);
  try{
    const m = await syncSheet(v, prevLink, prevTitle);
    if (m) toast(pre+'시트 반영: '+m); else if (!label) toast('시트에 반영할 내용이 없습니다');
    if (cur()?.sheetFail) await S.db.doc('videos/'+id).update({sheetFail:''}).catch(()=>{});
  }catch(e){
    toast(pre+sheetErr(e));
    await S.db.doc('videos/'+id).update({sheetFail:new Date().toISOString()}).catch(()=>{});
  }
}
async function syncSheet(v, prevLink, prevTitle){
  if (v.kind!=='H' || isTemp(v.code) || v.status==='제작 중') return '';
  return sheetCall({op:'sync', video:sheetVideo(v), prevLink:prevLink||'', prevTitle:prevTitle||''});
}

'''
s = rep_between(s, '/* ---------- Google Sheet sync (고객사용 시트, H 영상) ---------- */',
                '/* ---------- back to top ---------- */', SHEET_NEW)
s = rep_between(s, 'async function removeSheetRow(v){', 'async function finalizeTemp(v, nv, code){',
                '''async function removeSheetRow(v){
  if (v.kind!=='H' || isTemp(v.code)) return '';
  return '시트 '+await sheetCall({op:'remove', video:sheetVideo(v)});
}
''')
s = rep(s, "구글 시트 반영 실패 · 고객사용 시트에 이 영상", "구글 시트 반영 실패 · 구글 시트에 이 영상")

# 5) 권한: 처음엔 보기 전용, 관리자 로그인 후 편집
s = rep(s, "mod:null, reason:'', canWrite:true,", "mod:null, reason:'', canWrite:false,")
BOOT_OLD = s[s.index("  claude.use('user').then(async u=>{ S.user=u;"):]
BOOT_OLD = BOOT_OLD[:BOOT_OLD.index('\n') + 1]
BOOT_OLD += s[s.index(BOOT_OLD) + len(BOOT_OLD):].split('\n', 1)[0] + '\n'
s = rep(s, BOOT_OLD, '''  claude.use('user').then(u=>{ S.user=u; });
  applyAuth();
  if (HSG.mode==='admin') HSG.checkStored().then(ok=>{ applyAuth(); if(!ok) showLogin(); });
''')

# 6) 직원용에서는 관리 메뉴 숨김 + 로그인 창
AUTH_JS = r'''
/* ---------- 직원용 / 관리자용 ---------- */
const ADMIN_VIEWS = ['check','add','admin'];
function applyAuth(){
  S.canWrite = HSG.admin;
  document.querySelectorAll('#tabs a').forEach(a=>{ a.hidden = HSG.mode!=='admin' && ADMIN_VIEWS.includes(a.dataset.v); });
  const who=$('#who');
  if (HSG.mode==='admin'){
    who.innerHTML = HSG.admin ? '관리자 · <button type="button" class="linkish" id="logout">로그아웃</button>' : '<button type="button" class="linkish" id="loginBtn">관리자 로그인</button>';
    $('#logout')?.addEventListener('click',()=>{ HSG.logout(); applyAuth(); toast('로그아웃했습니다'); showLogin(); });
    $('#loginBtn')?.addEventListener('click',showLogin);
  } else who.textContent='';
  if (HSG.mode!=='admin' && ADMIN_VIEWS.includes(S.view)) { location.hash='#search'; return; }
  render(); if (S.open && !S.editing) renderSheet();
}
function showLogin(){
  if (HSG.mode!=='admin' || $('#loginBox')) return;
  const box=document.createElement('div'); box.id='loginBox'; box.className='login-wrap';
  box.innerHTML=`<form class="login card" id="loginForm" autocomplete="off">
    <h2>관리자 로그인</h2>
    <p class="hint">영상 등록·수정·삭제와 관리 메뉴를 쓰려면 관리자 비밀번호를 넣어 주세요. 이 기기에서는 한 번만 넣으면 됩니다.</p>
    <input type="password" id="loginPw" placeholder="관리자 비밀번호" aria-label="관리자 비밀번호" autocomplete="current-password" required>
    <div class="login-err" id="loginErr" role="alert"></div>
    <div class="actions"><button type="submit" class="primary">로그인</button><button type="button" id="loginSkip" class="ghost">보기만 하기</button></div>
  </form>`;
  document.body.appendChild(box);
  $('#loginPw').focus();
  $('#loginSkip').onclick=()=>box.remove();
  $('#loginForm').onsubmit=async e=>{ e.preventDefault(); const b=e.target.querySelector('[type=submit]'); b.disabled=true; $('#loginErr').textContent='';
    const ok=await HSG.login($('#loginPw').value); b.disabled=false;
    if (ok){ box.remove(); applyAuth(); toast('관리자로 로그인했습니다'); } else { $('#loginErr').textContent='비밀번호가 맞지 않습니다.'; $('#loginPw').select(); } };
}
window.addEventListener('hsg-auth', ()=>{ applyAuth(); });
'''
s = rep(s, "function setView(v){ S.view = v;",
        AUTH_JS + "function setView(v){ if (HSG.mode!=='admin' && ADMIN_VIEWS.includes(v)) { v='search'; if(location.hash!=='#search') history.replaceState(null,'','#search'); } S.view = v;")

AUTH_CSS = '''
.linkish{background:none;border:0;padding:0;color:var(--accent);font:inherit;cursor:pointer;text-decoration:underline}
.login-wrap{position:fixed;inset:0;background:rgba(15,20,30,.45);display:grid;place-items:center;z-index:200;padding:16px}
.login{width:min(380px,100%);display:block}
.login h2{margin:0 0 6px;font-size:18px}
.login input{width:100%;margin:12px 0 4px}
.login-err{color:var(--bad);min-height:20px;font-size:13px}
#tabs a[hidden]{display:none}
'''
s = rep(s, '</style>', AUTH_CSS + '</style>')

# 7) 런타임 연결 (본문 스크립트보다 먼저)
head_scripts = ('<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js"></script>\n'
                '<script>window.HSG_MODE=%s;</script>\n<script>\n' + runtime + '</script>\n')
s = rep(s, '<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>',
        '%%RUNTIME%%<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>')
s = s.rstrip() + '\n</body>\n</html>\n'

if 'claude.ai' in s.replace('claude.ai/code', ''):
    for m in re.finditer(r'.{40}claude\.ai.{40}', s):
        print('WARN', m.group(0))

for mode, out in (('staff', ROOT / 'index.html'), ('admin', ROOT / 'admin/index.html')):
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(s.replace('%%RUNTIME%%', head_scripts % repr(mode)), encoding='utf-8')
    print('wrote', out.relative_to(ROOT), len(s))
