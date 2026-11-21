# Dooray Dbins 호출·연계 참조

## 호출과 응답

서버명은 dooray-dbins다. DriveWorker 통합의 최신 use-drive-worker 스킬에 따라 mcp-call 명령을 전달하고 동일 job_id의 최종 결과를 확인한다. 일반 요청의 target_server는 생략한다. 이 참조와 도구 정의로 충분하면 Drive 인덱스·사용법·modifiedTime을 조회하지 않는다. 누락·불일치가 확인되면 실제 tools/list로 보완한다.

도구별 description·inputSchema·outputSchema·기본값·enum·범위는 [도구 정의](tool-snapshot.json)를 정본으로 사용한다. 도구를 선택한 뒤 tools 배열에서 name이 일치하는 항목의 정의를 읽고 적용한다. 이 문서는 schema에 없는 operation별 조건·연계·오류 해석과 호출 예시를 제공하며 같은 입력 정의를 다시 나열하지 않는다. 예시는 현재 인증·권한 성공을 보장하지 않는다. DISCOVERED_*는 목록·검색으로 얻은 실제 값으로 교체한다. 명령 인자를 JSON 직렬화한 뒤 셸 quoting을 적용하며 사용자 입력을 셸 코드에 그대로 보간하지 않는다.

mcp-call의 바깥 result에서 isError·structuredContent·content를 확인한다. CalDAV/CardDAV는 structuredContent.ok/data/error를 사용하지만, data.sources 안의 source별 오류도 별도로 확인한다. 상위 ok=true만으로 모든 주소록 성공을 판단하지 않는다. Dooray API는 도구에 따라 content 텍스트 또는 structuredContent.data로 응답한다. HTTP 오류·resultCode/header.success 등 반환된 실제 실패 신호를 확인한다. schema가 null 또는 data={}인 경우 실제 결과 필드·페이지 계약을 읽고 해석한다.

## operation별 추가 인자

다음 표의 식별자는 선행 목록·검색에서 확보한다. optional schema와 실제 연산에 필요한 식별자를 구분한다. page/size는 API 계열에서 page=0부터 시작하고 size는 1∼100을 사용한다. 반환 total/hasMore 또는 결과 길이와 실제 페이지 정보를 확인하며 응답 한도를 전체 건수로 해석하지 않는다. CalDAV/CardDAV의 limit·cursor와 API의 page·size는 서로 다르다.

| 도구 | operation | 추가 입력·조회 절차 |
|---|---|---|
| dooray_common | me / members | me는 추가 식별자 없음. members는 name·userCode·userCodeExact·idProviderUserId·externalEmails 등 실제 필터로 검색한다. |
| dooray_common | member / incoming_hook | 각각 memberId / incomingHookId가 필요하다. hook 비밀 URL을 답변에 노출하지 않는다. |
| dooray_projects | list_projects / is_creatable | 목록·생성 가능 여부 조회이며 실제 프로젝트 생성이 아니다. |
| dooray_projects | project | projectId 또는 서버가 지원하는 code 식별을 사용한다. |
| dooray_projects | workflows / milestones / tags / members / member_groups / templates | projectId로 해당 프로젝트 하위 목록을 조회한다. |
| dooray_projects | email_address | projectId와 emailAddressId를 해당 API 정의에 맞게 사용한다. |
| dooray_projects | milestone / tag / member / member_group / template | projectId와 각각 milestoneId / tagId / memberId / memberGroupId / templateId가 필요하다. |
| dooray_tasks | list_tasks | 프로젝트 범위면 projectId를 사용한다. fromMemberIds·toMemberIds·ccMemberIds·tagIds·postWorkflowClasses·postWorkflowIds·milestoneIds 등은 문자열 배열이다. subjects·createdAt·updatedAt·dueAt·order는 문자열이다. 날짜 필터 문법은 실제 Dooray API 계약을 확인하고 ISO 범위를 임의 결합하지 않는다. |
| dooray_tasks | task / comments / attachments | projectId와 taskId를 사용한다. 본문·댓글·첨부 목록은 별도 응답이다. |
| dooray_tasks | attachment_metadata | projectId·taskId·fileId를 사용한다. 파일 본문 다운로드는 지원하지 않는다. |
| dooray_messenger | channels | 조회 가능한 채널 목록이다. 메시지 읽기·보내기를 뜻하지 않는다. |
| dooray_calendar | raw_calendars | API 캘린더 식별자를 확보한다. CalDAV href를 calendarId로 전달하지 않는다. |
| dooray_calendar | events | calendars 문자열 배열, timeMin·timeMax를 시간대가 있는 ISO 8601로 제공한다. category·page·size는 필요한 경우 사용한다. |
| dooray_calendar | event | calendarId와 eventId로 단일 일정을 조회한다. |
| dooray_wiki | wikis / pages | pages는 wikiId를 사용하고 parentPageId는 해당 하위 범위를 조회할 때 사용한다. |
| dooray_wiki | page / page_by_wiki | pageId로 상세 조회하며 page_by_wiki는 wikiId도 함께 지정한다. |
| dooray_wiki | comments / comment | pageId와, 단일 댓글이면 commentId도 지정한다. 필요한 wikiId는 해당 연산 정의에 맞게 사용한다. |
| dooray_drive | drives / files / file_metadata | files는 driveId와 필요 시 parentId·type·subTypes·scope·state·projectId로 좁힌다. file_metadata는 driveId·fileId를 사용한다. 본문 다운로드를 뜻하지 않는다. |

## 일정·연락처 연계와 오류

- calendar_list_calendars 결과의 href를 calendar_get_events/calendar_search_events에 사용한다. start/end는 시간대를 포함한다. 개인업무·공유업무·휴가 등 요청과 관련된 캘린더를 선택하고 하나만 읽고 모든 업무 일정을 확인했다고 하지 않는다. 반복·종일·취소 상태와 출력 한도를 확인한다.
- carddav_search_contacts는 source=personal/organization/all과 query를 사용한다. 조직 결과가 incomplete 또는 nextCursor를 제공하면 query/source/addressBookHref를 유지하고 cursor만 갱신하여 필요한 범위까지 조회한다. 빈 불완전 페이지를 부존재로 처리하지 않는다. carddav_get_contact는 source=personal/organization 중 하나와 실제 uid 또는 href가 필요하다. all은 단일 연락처 상세 source로 허용되지 않는다.
- CalDAV 일정, 개인 CardDAV, 조직 CardDAV, Dooray API는 인증 경로가 다르다. 실제 응답으로 각각 판정하고, 개인 주소록 실패를 조직 주소록 실패로 확대하지 않는다. API 인증 실패를 일정 없음으로 처리하지 않는다.
- dooray_check_connection은 서버 도달성만 확인한다. 실제 API 인증은 dooray_whoami, CalDAV는 calendar_list_calendars/이벤트, CardDAV는 각 source의 실제 조회로 확인한다. service_status는 testConnections=true일 때만 upstream 검증을 요청한다. 매 호출마다 진단 도구를 선행하지 않는다.
- dooray_api_get은 문서화된 GET 경로의 보완용이다. host는 고정되어 있고 /<service>/v<number>/... 형식의 실제 path와 query 객체를 사용한다. 경로 순회·리다이렉트·바이너리 다운로드를 허용하지 않으며 임의 외부 URL·변경 요청을 전달하지 않는다. 새 경로·불명확한 필터는 필요한 API 문서나 서버 help만 추가 확인한다.

## 도구별 호출 예시

필요한 예시만 선택하고 호출 전 같은 name의 도구 정의를 확인한다. 예시는 전체 인자 정의를 대신하지 않는다.

### service_status

```sh
mcp-call dooray-dbins call service_status '{"testConnections":false}'
```

### calendar_list_calendars

```sh
mcp-call dooray-dbins call calendar_list_calendars '{}'
```

### calendar_private_write_readiness

기존에 지정된 개인업무 캘린더에 대해 서버가 보고한 WebDAV 권한 정보를 읽는다. 인자는 빈 객체이며 일정·권한·보안 설정을 변경하지 않는다. 응답의 content 텍스트 JSON에서 실제 권한 항목과 오류를 확인한다. 이 권한 조회 결과를 일정 생성·삭제의 실행 결과로 보고하지 않는다.

```sh
mcp-call dooray-dbins call calendar_private_write_readiness '{}'
```

### calendar_get_events

```sh
mcp-call dooray-dbins call calendar_get_events '{"calendarHref":"DISCOVERED_CALENDAR_HREF","start":"2026-10-30T00:00:00+09:00","end":"2026-10-31T00:00:00+09:00","limit":100}'
```

### calendar_search_events

```sh
mcp-call dooray-dbins call calendar_search_events '{"calendarHref":"DISCOVERED_CALENDAR_HREF","query":"회의","start":"2026-10-30T00:00:00+09:00","end":"2026-10-31T00:00:00+09:00","limit":25}'
```

### carddav_list_address_books

```sh
mcp-call dooray-dbins call carddav_list_address_books '{"source":"all"}'
```

### carddav_search_contacts

```sh
mcp-call dooray-dbins call carddav_search_contacts '{"source":"organization","query":"김진수","limit":20}'
```

### carddav_get_contact

```sh
mcp-call dooray-dbins call carddav_get_contact '{"source":"organization","uid":"DISCOVERED_CONTACT_UID"}'
```

### dooray_check_connection

```sh
mcp-call dooray-dbins call dooray_check_connection '{}'
```

### dooray_whoami

```sh
mcp-call dooray-dbins call dooray_whoami '{}'
```

### dooray_common

```sh
mcp-call dooray-dbins call dooray_common '{"operation":"me"}'
```

### dooray_projects

```sh
mcp-call dooray-dbins call dooray_projects '{"operation":"list_projects","page":0,"size":20}'
```

### dooray_tasks

```sh
mcp-call dooray-dbins call dooray_tasks '{"operation":"list_tasks","projectId":"DISCOVERED_PROJECT_ID","page":0,"size":20}'
```

### dooray_messenger

```sh
mcp-call dooray-dbins call dooray_messenger '{"operation":"channels","page":0,"size":20}'
```

### dooray_calendar

```sh
mcp-call dooray-dbins call dooray_calendar '{"operation":"raw_calendars"}'
```

### dooray_wiki

```sh
mcp-call dooray-dbins call dooray_wiki '{"operation":"wikis","page":0,"size":20}'
```

### dooray_drive

```sh
mcp-call dooray-dbins call dooray_drive '{"operation":"drives","page":0,"size":20}'
```

### dooray_api_get

```sh
mcp-call dooray-dbins call dooray_api_get '{"path":"/common/v1/members/me"}'
```

### dooray_capabilities

```sh
mcp-call dooray-dbins call dooray_capabilities '{}'
```


