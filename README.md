# HSG 영상 DB

HSG 영상 목록·검색·모듈별 보기·영상 카달로그(PDF) 사이트입니다. 로그인 없이 링크로 열립니다.

| 주소 | 용도 |
|---|---|
| `https://solution-hsg.github.io/hsg-video-db/` | 일반 직원용: 보기, 검색, 카달로그 만들기 |
| `https://solution-hsg.github.io/hsg-video-db/admin/` | 관리자용: 위 기능 + 등록·수정·삭제, 썸네일·스크립트, AI 요약, 관리 |

## 구성

| 부분 | 위치 | 설명 |
|---|---|---|
| 화면 | 이 저장소 (GitHub Pages) | `src/app.html` + `src/runtime.js` → `tools/build.py` 실행 → `index.html`, `admin/index.html` |
| 데이터·파일 | Supabase 프로젝트 `hsg-video-db` (서울) | `docs` 표 하나에 영상·모듈·모듈 연결·강사·설정 저장, 썸네일은 Storage `files/t/` |
| 서버 함수 | `supabase/functions/api` | 쓰기(관리자 비밀번호 확인), AI(Claude API), 구글 시트 반영 |
| 시트 반영 | `apps-script/HSG_시트반영.gs` | 고객사용 시트, 영상리스트(H_판매용영상), 모듈리스트(V.4) |
| 자동 작업 | `.github/workflows/keepalive.yml` | 매일 접속(무료 플랜 멈춤 방지), 월요일 전체 백업(Actions 아티팩트, 90일 보관) |

## 비밀값 (Supabase → Edge Functions → Secrets)

- `ANTHROPIC_API_KEY`: Claude API 키
- `ADMIN_PASSWORD`: 관리자 비밀번호

비밀값은 이 저장소에 넣지 않습니다.

## 화면 고치기

`src/app.html` 또는 `src/runtime.js`를 고친 뒤 `python3 tools/build.py`를 실행하고 커밋합니다.
