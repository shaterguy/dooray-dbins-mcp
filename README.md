# dooray-dbins-mcp

Vercel에 배포하는 Dooray REST·CalDAV·CardDAV 조회 전용 MCP 서버입니다. 하나의 stateless Streamable HTTP endpoint에서 18개 읽기 전용 도구를 제공합니다.

## 제공 도구

- Dooray REST 11개: `dooray_check_connection`, `dooray_whoami`, `dooray_common`, `dooray_projects`, `dooray_tasks`, `dooray_messenger`, `dooray_calendar`, `dooray_wiki`, `dooray_drive`, `dooray_api_get`, `dooray_capabilities`
- CalDAV 4개: `service_status`, `calendar_list_calendars`, `calendar_get_events`, `calendar_search_events`
- CardDAV 3개: `carddav_list_address_books`, `carddav_search_contacts`, `carddav_get_contact`

CardDAV source는 `personal`(carddav.dooray.co.kr)과 `organization`(carddav-members.dooray.co.kr)으로 고정됩니다. 인증은 `DOORAY_USERNAME` / `DOORAY_PASSWORD`를 CalDAV와 CardDAV에서 공통 사용하며 CardDAV 전용 자격증명 환경변수는 없습니다.

모든 도구에는 read-only annotation이 적용됩니다. Dooray REST는 GET만 사용하고, CalDAV·CardDAV는 조회용 OPTIONS·PROPFIND·REPORT·GET만 사용합니다. CardDAV 응답은 제한된 연락처 필드만 반환하고 전체 vCard, PHOTO, SOUND, KEY는 반환하지 않습니다. 조직 검색은 정렬된 href·ETag 목록을 확인하고 요청당 최대 256개 리소스를 동시 16개 GET으로 읽습니다. 발견·목록 조회·응답 본문을 포함한 전체 작업시간은 40초입니다. 검색은 전체 인덱스 구축을 기다리지 않습니다. 로컬 self-host 런타임은 시작 직후 인덱스 워밍업을 비동기로 시작하므로 MCP 요청의 기본 제한시간과 전체 인덱스 구축을 분리합니다. 최대 20,000개 리소스로 제한하고, 개별 vCard는 최대 5 MiB까지만 읽은 뒤 PHOTO·NOTE·SOUND·KEY 등 비허용 속성을 제거하고 기존 허용 필드만 파싱·반환합니다.

## MCP 엔드포인트

```text
https://<your-vercel-project>.vercel.app/<64-character-path-token>/mcp
```

경로 토큰은 필수이며 직접 `/api/mcp` 경로는 차단됩니다. MCP 클라이언트가 지원하면 별도 `MCP_ACCESS_KEY`를 Bearer 또는 `X-MCP-Access-Key`로 보낼 수 있습니다.

## 환경변수

| 이름 | 필수 | 설명 |
|---|---:|---|
| `MCP_PATH_TOKEN` | 예 | 정확히 64자의 URL-safe 경로 보호 secret |
| `DOORAY_USERNAME` | 예 | CalDAV·CardDAV Basic auth에 공통 사용 |
| `DOORAY_PASSWORD` | 예 | CalDAV·CardDAV Basic auth에 공통 사용 |
| `DOORAY_API_TOKEN` | 예 | Dooray REST 개인 API token |
| `MCP_ACCESS_KEY` | 아니오 | Bearer 또는 사용자 정의 헤더 호환 access key |
| `MCP_ALLOWED_ORIGINS` | 아니오 | 추가 허용 Origin, 쉼표 구분 |
| `DOORAY_BASE_URL` | 아니오 | 기본값 `https://api.dooray.com` |
| `DOORAY_ALLOWED_HOSTS` | 아니오 | 추가 허용 Dooray host, 쉼표 구분 |
| `DOORAY_TIMEOUT_MS` | 아니오 | 기본값 20,000ms |
| `DOORAY_MAX_RESPONSE_BYTES` | 아니오 | 기본값 2,000,000 bytes |
| `DOORAY_MAX_TOOL_TEXT_CHARS` | 아니오 | 기본값 120,000자 |

실제 secret은 Vercel Environment Variables 또는 로컬의 무시되는 `.env.local`에만 저장하고 커밋하지 않습니다.

## 로컬 검증

```bash
npm ci
npm run check
```

## Vercel 배포

1. 공개 GitHub 저장소를 Vercel의 New Project에서 Import합니다.
2. Framework Preset은 Other 또는 자동 감지를 사용하고 Build Command는 `npm run build`으로 둡니다.
3. Production 환경변수를 등록합니다.
4. 배포 후 `/<64-character-path-token>/mcp`에서 MCP initialize와 tools/list를 확인합니다.

## 주소록 발견 진단

`carddav_list_address_books`가 실패하거나 일부 source가 실패하면 `data.diagnostics`에 제한된 진단을 반환합니다. source와 고정 경로의 이름, HTTP 상태 또는 안전한 오류 코드, 알려진 인증 방식 이름만 포함합니다. 실제 URL, 계정, 비밀번호, 인증 헤더, 쿠키, 응답 본문과 연락처는 진단에 포함하지 않습니다. 성공 응답과 기존 접속 경로·인증 방식은 바뀌지 않습니다. 이 진단은 실패 위치를 구분하기 위한 것이며 인증 또는 개인 주소록 복구 성공을 의미하지 않습니다.

## 조직 검색 이어받기

`incomplete: true`인 빈 페이지를 검색 결과 없음으로 해석하지 마세요. `nextCursor`가 있으면 같은 source·query·addressBookHref와 해당 cursor로 다음 페이지를 요청하고 결과를 모읍니다. limit은 페이지별 결과 수이며 전체 탐색 범위를 제한하지 않습니다. nextCursor가 null이어도 incomplete가 true라면 리소스 한도·잘못된 vCard·source 실패 때문에 확인 범위가 불완전합니다.

커서에는 버전·해시·숫자 위치·누락 여부만 있고 URL·연락처·계정·인증정보는 없습니다. 커서는 권한 증명이 아니며 매번 기존 인증과 발견으로 접근 범위를 검증합니다. 캐시 없이 다른 서버 인스턴스에서도 이어받습니다. href·ETag 목록이 바뀌면 CARDDAV_CURSOR_STALE로 처음부터 검색하도록 알립니다. ETag가 없는 리소스의 본문 변경은 탐지하지 못하므로 원자적인 스냅샷을 보장하지 않습니다.

source: all의 개인 결과는 첫 페이지에만 포함됩니다. 기존 개인 검색은 전체 범위 검증을 제공하지 않으므로 all은 보수적으로 incomplete를 유지합니다. 조직 전체 검색 완료는 source: organization으로 확인하세요. 개인 전용 검색의 기존 동작은 유지됩니다.

resource_failed/source_unavailable에서 진행 위치가 그대로라면 무한 재시도하지 마세요. 주소록 PROPFIND 목록 자체는 upstream 페이지를 지원하지 않아 시간·크기 한도를 넘으면 안전한 오류로 종료됩니다. 새 저장소·백그라운드 작업·환경변수는 사용하지 않습니다.
