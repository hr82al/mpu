# Очередь работ хоста mpu — чеклист (живой, отмечать по ходу)

Читать первым после сжатия контекста или новой сессии. Подробности состояния —
`handoff.md`, вопросы владельцу — `docs/owner-questions.md`.

## Инструкции владельца (действуют, пока не отменены)

- Хост — спецификатор и постановщик; исполнитель — одна сессия в tmux `w`
  (`w:@8.%8`, каталог `~/mr/mp/mpu/ts`), передача через `ts/.tmp/buf.txt`
  (`deno task handoff`).
- **Без Workflow и без субагентов** — ни хосту, ни исполнителю (в каждую
  постановку — раздел «Трата контекста»: разбор диффа — сам, отдельным проходом).
- **Перед каждой постановкой — `/clear` исполнителю вводом через tmux**:
  `tmux send-keys -t w:@8.%8 '/clear'`, Enter отдельно, затем `go` + Enter;
  только после этого `deno task handoff post`.
- **Работать автономно.** Вопрос — решить самому эмпирически (код, живой
  прогон, стенд); не вышло — записать в `docs/owner-questions.md` и идти к
  следующей задаче.
- Прод не меняем; живая проба `ask`-пути — только строкой, про которую справка
  говорит, что она ничего не пишет (`ask telegram status dry no-live`,
  `ask image sync dry`); `telegram status` без `dry` ОТПРАВЛЯЕТ.
- Коммиты хоста — прямо в `main` mpu, пути поимённо, не пушить.
- Каталог образа `~/mr/mp/mpu/image/` — отслеживается в git (для того и нужен).
- Приёмка порции: отчёт → гейты сам (`fmt/lint/check/test`, `smoke`) → одна
  мутация сам → заморозка голденов в `ts/docs/specs/fixtures/` → `bash
  install.sh </dev/null` → живая проба → статус спеки «реализовано, принято …»
  → коммит.

## Последовательность

- [x] 167c — окно MCP только Accept/Decline
- [x] 167d — тесты установщика без `nu`
- [x] 169a — журнал `define:`/`forget:`, `log cmd:` видит `ask`, ключ `image.dir`
- [x] 169 — `image sync`
- [x] 169b — `image export` + суточный таймер
- [ ] 170a — программа из stdin (в работе у исполнителя)
- [ ] 170b — `run:` из файла (`prompt-170b.txt` готов в `~/mr/mp/tmp/mpu-smalltalk/`)
- [ ] 171 — web: экран «Образ» (`web-image.md`, постановку написать)
- [ ] call — `ts/docs/specs/call.md` (маркетплейс — получатель: `ozon call-ro`,
      `ozon perf call`, `wb call`). До постановки: реестр ручек чтения и отбор
      токенов WB — литералами в спеку (сбор начат 2026-09-25, см. ниже);
      разрезать спеку на порции.
- [ ] task — оркестратор `mpu task` (серия T1–T5, `docs/2026-09-23-task-orchestrator-design.md`,
      спека `ts/docs/specs/task.md`); план порций — при старте.
- [ ] mp-init — `ts/docs/specs/mp-init.md` (к реализации, 2026-09-24)
- [ ] mp-clone — `ts/docs/specs/mp-clone.md` (к реализации, 2026-09-24)

Отложено по плану языка (после 171, до/после call — решить по ходу):
слепая приёмка языка (sonnet, 9/10) и 172+ справки — требуют агентов →
спросить владельца (записано в `owner-questions.md`, если не отвечено).

## Заметки по call (сбор реестра, 2026-09-25)

- Ozon Seller (`api-seller.ozon.ru`), чтение загрузчиков `ozon`: все `POST`,
  кроме `GET /v1/actions`: `/v1/actions/products`, `/v1/actions/candidates`,
  `/v1/analytics/data`, `/v1/analytics/product-queries/details`,
  `/v1/analytics/stocks`, `/v1/finance/accrual/by-day`,
  `/v1/finance/accrual/types`, `/v1/finance/cash-flow-statement/list`,
  `/v1/finance/products/buyout`, `/v3/posting/fbo/list`,
  `/v3/posting/fbs/list`, `/v1/product/action/timer/status`,
  `/v4/product/info/attributes`, `/v4/product/info/stocks`,
  `/v3/product/list`, `/v3/product/info/list`, `/v1/report/postings/create`,
  `/v1/report/info`, `/v1/returns/list`, `/v1/roles`, `/v1/seller/info`.
- Ozon Performance (`api-performance.ozon.ru`): `GET /api/client/campaign`,
  `GET /api/client/statistics/daily/json`, `GET /api/client/statistics/report`,
  `GET /api/client/statistics/{}`, `GET /api/client/statistics/all_sku_promo/orders/generate/json`,
  `POST /api/client/statistic/products/generate/json`, `POST /api/client/statistics/json`.
- WB `wbGateway.registry.js`: `GET common-api.wildberries.ru/api/v1/seller-info`,
  `GET statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod`.
- Отбор токена WB (`sl-back` `wbTokens.model.js` `findBySid`): таблица
  `wb_tokens`, по `sid`; `exp` null или в будущем; `acc` null, или не в {2,3}
  и не 4, или 4 при `for = 'asid:<WB_API_SERVICE_ID>'`; плюс `is_valid`
  (стр. 122) и поле категории. Добрать: где таблица (sl-main public или
  инстанс), значение `WB_API_SERVICE_ID`, поля категорий (`PERMISSION_FIELDS`),
  GET-ручки загрузчиков `sl-back`.
