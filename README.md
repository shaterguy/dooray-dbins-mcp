# dooray-dbins-mcp

Vercel에 배포하는 Dooray REST·CalDAV·LDAP·CardDAV 조회 전용 MCP 서버입니다. 하나의 stateless Streamable HTTP endpoint에서 기존 18개 도구와 CardDAV 연락처 도구 3개를 제공합니다.

## 제공 도구

- Dooray REST 11개: `dooray_check_connection`, `dooray_whoami`, `dooray_common`, `dooray_projects`, `dooray_tasks`, `dooray_messenger`, `dooray_calendar`, `dooray_wiki`, `dooray_drive`, `dooray_api_get`, `dooray_capabilities`
- CalDAV·LDAP 7개: `service_status`, `calendar_list_calendars`, `calendar_get_events`, `calendar_search_events`, `directory_search_people`, `directory_get_person`, `directory_get_group_members`
- CardDAV 3개: `carddav_list_address_books`, `carddav_search_contacts`, `carddav_get_contact`

CardDAV source는 `personal`(carddav.dooray.co.kr)과 `organization`(carddav-members.dooray.co.kr)으로 고정됩니다. 인증은 기존 `DOORAY_USERNAME` / `DOORAY_PASSWORD`를 CalDAV·LDAP와 함께 재사용하며 CardDAV 전용 자격증명 환경변수는 없습니다.

모든 도구에는 read-only annotation이 적용됩니다. Dooray REST는 GET만 사용하고, CalDAV·CardDAV는 조회용 OPTIONS·PROPFIND·REPORT·GET만 사용하며, LDAP는 bind·search·unbind만 사용합니다. CardDAV 응답은 제한된 연락처 필드만 반환하고 전체 vCard, PHOTO, SOUND, KEY는 반환하지 않습니다.

## MCP 엔드포인트

```text
https://<your-vercel-project>.vercel.app/<64-character-path-token>/mcp
```

경로 토큰은 필수이며 직접 `/api/mcp` 경로는 차단됩니다. MCP 클라이언트가 지원하면 별도 `MCP_ACCESS_KEY`를 Bearer 또는 `X-MCP-Access-Key`로 보낼 수 있습니다.

## 환경변수

| 이름 | 필수 | 설명 |
|---|---:|---|
| `MCP_PATH_TOKEN` | 예 | 정확히 64자의 URL-safe 경로 보호 secret |
| `DOORAY_USERNAME` | 예 | CalDAV·CardDAV Basic auth와 LDAP bind에 공통 사용 |
| `DOORAY_PASSWORD` | 예 | CalDAV·CardDAV Basic auth와 LDAP bind에 공통 사용 |
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
