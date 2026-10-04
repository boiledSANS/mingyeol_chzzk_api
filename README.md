# Mingyeol CHZZK API

[![Skript](https://img.shields.io/badge/Skript-2.10.2%2B-F5A623?style=for-the-badge&logo=github&logoColor=white)](https://github.com/SkriptLang/Skript)
[![Paper](https://img.shields.io/badge/Paper-1.21-2F80ED?style=for-the-badge)](https://papermc.io/)
[![Java](https://img.shields.io/badge/Java-21-ED8B00?style=for-the-badge&logo=openjdk&logoColor=white)](https://adoptium.net/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)

치지직(CHZZK) 계정을 Minecraft 계정과 연동하고, 채널의 **구독·팔로우 상태를 Skript에서 사용하기 쉽게** 해주는 Paper 플러그인 + OAuth 백엔드 사실 codex가 거의다 만들어준거라 나도 자세히는 몰라몰라 몰라띠 난 skript한 손코딩하고 플러그인은 발로해버려잇

> [!IMPORTANT]
> 이 플러그인은 단독으로 동작하지 않는 **[Skript](https://github.com/SkriptLang/Skript) 애드온**입니다.
> 서버의 `plugins/` 폴더에 **Skript 2.10.2 이상**이 먼저 설치되어 있어야 하며, 없으면 플러그인이 로드되지 않습니다.

## 요구 사항

| 구성 요소 | 버전 | 비고 |
|---|---|---|
| [Skript](https://github.com/SkriptLang/Skript) | 2.10.2 이상 | **필수** · 원본 플러그인 (`depend: [Skript]`) |
| [Paper](https://papermc.io/) | 1.21.x | Spigot/Bukkit 미지원 |
| Java | 21 이상 | 플러그인 빌드·실행 |
| Node.js | 18 이상 | OAuth 백엔드 (`service/`) |
| MariaDB | 10.3 이상 | 계정 연동 공용 저장소 |

## 공용 DB 설정

```dotenv
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=mingyeol_api
DB_USER=mingyeol_api
DB_PASSWORD=<MariaDB에 설정한 비번>
DB_CONNECTION_LIMIT=10
```

## 서버 설정

1. `service/.env.example`을 `service/.env`로 복사하고 값을 채웁니다. 방송자 연동용 키는 아래처럼 생성합니다.

```dotenv
OWNER_SETUP_KEY=<openssl rand -hex 32 결과>
OWNER_TOKEN_ENCRYPTION_KEY=<openssl rand -base64 32 결과>
```

2. 치지직 Developers에서 아래 읽기 권한을 켭니다.

   - 유저 조회, 채널 정보 조회, 채널 관리자 조회
   - 구독 조회, 채팅 설정 조회, 활동제한 조회

3. Node 서비스를 재시작한 뒤, 처음 한 번 **방송자 본인** 브라우저에서 아래 주소를 엽니다.

```text
https://<서비스 주소>/admin/connect?key=<OWNER_SETUP_KEY>
```

연동 완료 화면이 나오면 서버가 암호화된 `data/chzzk-owner.json`에 조회용 토큰을 보관합니다. 이 URL과 `.env`는 공유하면 안 됩니다.

## 웹 화면

| 경로 | 설명 |
|---|---|
| `/` | 계정 연동 안내 홈 |
| `/terms`, `/privacy` | 이용약관, 개인정보 처리방침 |
| `/link-completed` | 연동 성공 화면 |
| `/link-failed?code=오류코드` | 연동 실패 화면 |
| `/chzzk/callback` | OAuth 처리 후 성공·실패 화면으로 `303` 이동 |
| `/health` | 서비스 실행 상태 |

화면 파일은 `service/site/`에 있습니다. 실패 화면의 오류 코드와 안내 문구는 서버가 HTML 이스케이프 후 채웁니다. `/v1/...` API의 존재하지 않는 주소는 JSON `404`를 반환합니다.

## Skript 문법

```vb
# 유저의 계정 연동 시작
chzzk_link player

# 특정 유저의 최신 상태를 즉시 다시 조회 (비동기)
chzzk_refresh_status player

# 방송자 조회 데이터 전체 새로고침 (운영자 명령 등에 사용)
chzzk_refresh_owner_data

# 팔로우 여부 및 구독 정보
if chzzk follower status of player is true:
    send "팔로워입니다." to player
send "티어: %chzzk subscriber tier of player%" to player
send "구독 개월 수: %chzzk subscriber months of player%" to player
```

`chzzk_refresh_status`는 비동기이므로, 호출 직후 같은 줄에서 결과를 검사하지 말고 잠시 뒤 사용하세요. 온라인 연동 유저는 `status-refresh-seconds` 설정값(기본 300초)마다 자동 갱신됩니다.

## Skript 변수

플레이어 UUID별 변수:

```text
{chzzk_linked::<uuid>}
{chzzk_channel_id::<uuid>}
{chzzk_channel_name::<uuid>}
{chzzk_subscriber::<uuid>}
{chzzk_subscriber_tier::<uuid>}
{chzzk_subscriber_months::<uuid>}
{chzzk_follower::<uuid>}
{chzzk_status_updated_at::<uuid>}
```

`chzzk_refresh_owner_data`를 실행하면 아래에도 읽기 응답이 저장됩니다.

```text
{chzzk_read::<resource>::channel_id}
{chzzk_read::<resource>::channel_name}
{chzzk_read::<resource>::data::*}
{chzzk_read_json::<resource>}
```

`<resource>`는 `channel`, `managers`, `followers`, `subscribers`, `live-settings`, `chat-settings`, `restrictions` 중 하나입니다. `data::*`는 치지직 응답의 필드를 재귀적으로 Skript 리스트 변수로 펼친 값이고, JSON 원문이 필요하면 `chzzk owner read json "subscribers"` 표현식을 사용합니다.

주석이 포함된 명령어·보상·관리자 조회 예제는 [`examples/`](examples/)에 있습니다.
