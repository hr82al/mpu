# mpu search

Статус: черновик

## Назначение

Поиск клиента/таблицы по селектору в локальном кэше (без сети) и доступ
к web-клиенту 10X: селектор → email цели → impersonation-сессия (вход
от лица клиента). Режим выбирают флаги; email всегда уходит в 10X.

## CLI-контракт

`mpu search VALUE [проекция] [--update/--no-update] [--reason TEXT]
[--refresh-cache] [--scope auto|user|access]`

Без аргумента — справка, exit 2. Проекционные флаги (не больше одного):
`--client-id`, `--spreadsheet-id`, `--title`, `--server`,
`--server-number`, `--sl-ip`, `--pg-ip`, `--sids`; больше одного →
stderr `mpu search: only one projection flag allowed`, exit 2 — до
любого обращения к БД и сети. Выбор режима: VALUE — email (маска
`^[^@\s]+@[^@\s]+\.[^@\s]+$`) и `--scope` не `access` → email-ветка;
задан `--reason`, `--refresh-cache` или `--scope` не `auto` →
10X-резолв селектора; иначе — локальный режим.

**Локальный режим.** Поиск по кэш-БД; порядок и семантика
предикатов — `platform/selector.md` (email-предикат недостижим).
Дополнительно:

- client_id- и sid-поиск — по строке на каждую таблицу клиента (без
  таблиц — одна строка с null-полями; server — из реестра клиентов);
  `sids` строки — все WB sid клиента по возрастанию, не только
  совпавший; нет sid'ов или их таблицы в старом кэше → `[]`;
- IP-похожий селектор → одна строка сервера `sl-<N>` из env-файла
  (client_id/spreadsheet_id/title — null); неизвестный адрес → `[]`;
- пустой результат при `--update` (дефолт) → полный quiet-синк кэша
  (`specs/update.md`) и повтор поиска ровно один раз; `--no-update` и
  IP-похожий селектор синк не запускают.

**10X-резолв не-email селектора.** Эффективный scope: `auto` →
`access` для целого (`^\d+$`) и полного uuid sid (8-4-4-4-12
hex-цифр, регистр не важен), иначе `user`. Тёплый кэш (`access`, без
`--refresh-cache`): client_id селектора (целое VALUE либо sid →
единственный client_id по кэшу sid'ов) уже среди owned строки
email-кэша → email берётся оттуда, 10X не вызывается. Иначе —
staff-поиск `GET /users/staff/search?query=<VALUE>&scope=<eff>` под
staff-токеном; элемент ответа `{id, email, name, isEmailVerified}`
плюс `match` `{via, role, workspaceId, workspaceName, sid,
cabinetName}` (только при `scope=access`). Кандидат: точный email ==
VALUE → иначе кандидаты с `match.role == "owner"` → иначе весь пул; в
пуле больше одного → неоднозначность (exit 2, без impersonation):
stderr-ошибка + JSON-список `{user_id, email, name, match}` в stdout.
Названием клиента/воркспейса/кабинета staff-поиск не находит никого
ни в одном scope — путь «имя → client_id» один: локальный title-поиск;
найденный email уходит в email-ветку.

**email-ветка.** Кэш email→клиент (ключ — email в нижнем регистре).
На miss или при `--refresh-cache` — резолв через 10X API, строго:

1. staff-токен: валидный из кэша, иначе `POST /auth/login` с телом
   `{"email": <X10_LOGIN>, "password": <X10_PASSWORD>}` → `data.access_token`;
2. `GET /users/staff/search?query=<email>` (без scope) → exact-match
   по email; ноль или больше одного → ошибка;
3. `POST /auth/impersonate`, тело `{"targetUserId": <user.id, целое>,
   "reason": <причина>}` → `data.access_token`; пишет audit-запись на проде;
4. `GET /workspaces` под impersonation-токеном; owned — элементы, чей
   `ownerId` равен user.id цели; `workspace.id == client_id`.

Результат пишется в кэш (email→клиент + сессии). Owned client_id вне
локального снапшота дотягивается точечным синком (`specs/update.md`);
не нашёлся и там → stderr `warning: client <id> не найден в реестре
(показан без таблицы)` + «голая» строка в выводе (все поля null, sids
`[]`), exit 0. `--reason` — причина impersonation (аудит), дефолт
`ТП <YYYY-MM-DD>` (текущая дата), потребляется только при создании
новой сессии.

**HTTP и кэш токенов.** Запросы с `accept: application/json` и
`authorization: Bearer <токен>`; успешный ответ 10X — обёртка
`{success, message, data}`, берётся `data`; non-2xx → ошибка `<METHOD>
<путь>: HTTP <код>`, exit 2. Сессии кэшируются по паре (вид `staff` |
`impersonation`; субъект — логин-email | user.id цели); срок годности —
`exp` из payload JWT (base64url, подпись не проверяется) минус 60 с,
не извлёкся → 600 с. Валидная сессия переиспользуется без сети; 401
под кэш-токеном → одно повторение с обновлением токена.

## Ввод/вывод

Локальный режим без проекции — stdout, JSON-массив объектов с ровно
восемью ключами `{"client_id", "spreadsheet_id", "title", "server",
"server_number", "sl_ip", "pg_ip", "sids"}`; отсутствующее значение —
null (не пустая строка); indent=2, unicode как есть; пусто → `[]`,
exit 0. Проекция — по строке на строку результата, голое значение
поля; null → пустая строка; `--sids` → sid'ы через запятую.

email/10X-режим без проекции — stdout, JSON-объект: `email`,
`target_user_id` (строка), `target_name`, `is_email_verified`,
`reason`, `fetched_at` (unix-секунды), `owned` (строки формата выше),
`member_only` (`{workspace_id, name, marketplace}` — воркспейсы, где
цель не владелец), `sessions`, `workspaces` (сырой `data[]`). Элемент
`sessions` — `{kind, subject, reason, created_at, expires_at, valid,
token}`: staff- и impersonation-сессия цели, сортировка по kind,
`valid` — expires_at больше текущего времени, token целиком. С
проекцией печатаются только owned-строки.

Ошибки: stderr `mpu search: <причина>`, без трейсбеков; к 401/403 —
суффикс ` (нужны 10X staff-креды X10_LOGIN/X10_PASSWORD, не sl-back
TOKEN_*)`. Exit: 0 — успех (включая пустой результат и warning'и);
2 — ошибки ввода и весь 10X-резолв; 1 — сбой авто-синка.

## Побочные эффекты

Локальный режим: чтение кэш-БД и env-файла, сети нет; auto-update —
эффекты полного синка. 10X-ветка на холодном кэше: до четырёх
HTTP-вызовов (login, staff-поиск, impersonate, workspaces);
impersonate создаёт audit-запись на проде — необратимо; запись в
кэш-БД + точечные синки owned-клиентов; тёплый кэш → ноль обращений к
10X. 10X-ветки идемпотентно создают недостающие таблицы своего кэша.
Вывод не попадает в журнал вызовов — запись без секций вывода
(`platform/invoke-log.md`): stdout содержит живые токены.

## Конфигурация

Env-файл (`platform/config.md`): `X10_URL` (fallback `X10_API_URL`) —
базовый URL 10X (хвостовые `/` отрезаются, суффикс `/api` добавляется,
если его нет), дефолт `https://app.system10x.ru/api`; `X10_LOGIN` /
`X10_PASSWORD` — staff-креды 10X (auth-система sw-back, не sl-back),
нужны только при реальном вызове 10X, иначе exit 2, stderr
`mpu search: 10X credentials missing: <имена через запятую>. Add to
<путь env-файла> or export in shell.`; `sl_<N>` / `pg_<N>` —
IP-предикат и поля sl_ip/pg_ip. Кэш-БД `~/.config/mpu/mpu.db`: снапшот
клиентов/таблиц/sid'ов (`specs/update.md`), email-кэш 10X (PK email) и
кэш сессий 10X (PK (kind, subject)).

## Инварианты

- Каждая строка локального результата и owned-строка несут одинаковый
  набор из восьми ключей; ключ не выпадает, `sids` — всегда массив.
- Локальный режим в сеть не ходит, кроме auto-синка — не более одного
  раза за вызов и никогда для IP-похожего селектора; 10X недостижим.
- 10X вызывается только на cache-miss или `--refresh-cache`; валидный
  токен + email в кэше → ответ целиком из кэш-БД.
- impersonation-сессия создаётся только при отсутствии валидной
  кэш-сессии; неоднозначный staff-поиск сессию не создаёт.
- Порядок вывода детерминирован: таблицы — по spreadsheet_id, клиенты
  (sid-поиск) — по client_id, title-поиск — по (title, spreadsheet_id).

## Граничные случаи и ошибки

Ошибки 10X ниже — stderr с префиксом `mpu search: `, exit 2.
- Сеть недоступна → `<METHOD> <путь>: transport error: <детали>`;
  ответ не-JSON или без `data` → ошибка с описанием.
- Точного email нет → `10X staff search: нет пользователя с точным
  email '<email>' (по substring найдено <N>); проверь адрес или что
  это не staff-аккаунт`.
- Больше одного юзера с email → `10X staff search: несколько юзеров с
  email '<email>': ids=[…]`.
- Ноль кандидатов → `10X staff search (scope=<eff>): по '<VALUE>'
  никого не найдено; названием клиента/кабинета не ищется — используй
  client_id, sid, email или имя`.
- Несколько кандидатов → `10X staff search (scope=<eff>): по '<VALUE>'
  найдено кандидатов: <N>; повтори с точным email или с user.id
  (--scope user)` + stdout JSON-список.
- Число, существующее только как user.id → в auto/access ноль
  кандидатов; email + `--scope access` → «никого не найдено».
- user.id в ответе не целое → `10X staff search (scope=<eff>): user.id
  не число: <значение>`.
- Нет access_token → `10X login: нет access_token в ответе` /
  `10X impersonate: нет access_token в ответе`.
- Email после резолва отсутствует в кэше → `<email> не резолвится в
  client_id`.

## Golden-примеры

Снять при переводе в «к реализации» — на синтетической кэш-БД и
env-файле, без сети (10X-ветку с прода не снимать: impersonate пишет
audit; её контракт закрывают обезличенные фикстуры ответов API в
`fixtures/search/`). Кандидаты: `search 10 --no-update` (happy path);
`search 10 --client-id --no-update` и `search 10 --sids --no-update`
(проекции); `search 10.0.0.1 --no-update` (IP из env-файла);
`search <sid> --no-update`; `search NOPE_XYZ --no-update` (пусто без
синка, exit 0); `search X --client-id --title` (конфликт, exit 2).

## Известные отклонения

- **preserve** — IP-предикат матчит четыре группы из 1–3 цифр без
  проверки диапазона октетов. Причина: единая трактовка «IP-похожего»
  с резолвом селектора (`platform/selector.md`); ужесточение раздвоило
  бы ветвление одного значения между командами.
- **fix** — суффикс-подсказка про креды (401/403) добавляется только в
  email-ветке; правильное поведение — в обеих ветках («Ввод/вывод»).
- **fix** — сбой авто-синка (main недоступен) роняет команду
  трейсбеком. Правильное поведение: ошибка синка без трейсбека
  (форма — `specs/update.md`), exit 1, повторный поиск не выполняется.

## Открытые вопросы

- Ответ staff-поиска `scope=access` для не-владельца (`match.role ==
  "admin"`) идёт общим путём (owner-приоритет → пул), живой фикстуры
  нет — снять обезличенную при переводе в «к реализации».
- Две строки email-кэша с одним client_id: какая побеждает в тёплом
  кэше, не закреплено — выбрать детерминированное правило + тест.
