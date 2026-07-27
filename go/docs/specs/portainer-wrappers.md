# mpu node-CLI обёртки — семейство команд

Статус: черновик

## Назначение

Семь команд-обёрток, каждая запускает один метод sl-back CLI
(`node cli service:<сервис> <метод>`) в контейнере `mp-sl-N-cli` сервера
клиента. Общая машинерия (режимы, сборка inner-команды, валидация,
auto-pick) — `platform/portainer.md`; здесь — CLI-поверхность и таблица
«обёртка → inner-команда → эффект». Не путать с `mpu api wb-loader-*`
(HTTP-семейство, отдельные спеки).

## CLI-контракт

Общий синопсис:
`mpu <обёртка> [<sub>] SELECTOR [--server sl-N] [--print/-p] [--local]
[--client-id N] [доменные флаги]`

- `SELECTOR` — базовый резолв `platform/selector.md`; `--server sl-N` —
  override сервера.
- `--client-id` — явное значение; без него auto-pick из кандидатов
  (`platform/portainer.md`).
- `--print`/`-p`, `--local` — режимы печати (`platform/portainer.md`);
  `--print` — read-only-вариант семейства
  (`platform/readonly-default.md`, паттерн exec-обёрток: дефолт — писать
  немедленно).
- У каждого доменного флага два равнозначных написания: kebab и snake
  (`--date-from` / `--date_from`); канон в inner-команде — kebab.
- Команда (или группа) без аргументов/подкоманды печатает справку,
  exit 2.

Таблица семейства (сервис и метод — дословно; `<C>` = client_id):

| Обёртка | Inner-команда | Доменные флаги | Эффект |
| --- | --- | --- | --- |
| `ss-update` | `service:ssUpdater update --client-id <C> --spreadsheet-id <S> --update-type <T> --logs <L>` | `--spreadsheet-id` (auto-pick), `--update-type` (default `schedule`), `--logs` (default `info`) | запуск пайплайна обновления Google-таблицы клиента |
| `wb-loader <sub>` | `service:wbLoader <метод> --client-id <C> --sid <SID>` | `--sid` — обязательный | загрузка данных WB-кабинета в БД клиента |
| `data-loader find-candidate` | `service:dataLoader findCandidate --client-id <C> --sids <S1> [<S2> …]` | `--sids` (алиас `--sid`) — повторяемый, обязательный; эмитится списком токенов | поиск кандидата загрузки по кабинетам |
| `wb-recalculate-expenses` | `service:wbUnitCalculatedData recalculateExpenses --client-id <C> --date-from <F> --date-to <T> [--nm-ids <[..]>]` | `--date-from` (default `2025-01-01`), `--date-to` (default — сегодняшняя локальная дата), `--nm-ids` — одна строка вида `[1,2,3]` без пробелов | пересчёт расходов WB UNIT за период |
| `wb-save-expenses` | `service:wbUnitCalculatedData saveExpenses …` (флаги как строкой выше) | те же | сохранение расходов WB UNIT за период |
| `ozon-recalculate-expenses` | `service:ozonUnitCalculatedData recalculateExpenses --client-id <C> --date-from <F> --date-to <T> [--ref-date <D>] [--ref-fields <F1> …] [--skus <[..]>] [--logs-level <L>]` | `--ref-date`; `--ref-fields` — повторяемый; `--skus` — повторяемый int, эмитится одним токеном `[v1,v2,…]`; `--logs-level`; `-v/--verbose` | пересчёт расходов Ozon UNIT за период (с опц. копированием полей из ref-даты) |
| `ozon-save-expenses` | `service:ozonUnitCalculatedData saveExpenses --client-id <C> --date-from <F> --date-to <T>` | только даты (дефолты как у wb-*) | сохранение расходов Ozon UNIT за период |

Подкоманды `wb-loader` → метод: `reports` → `wbReports`; `cards` →
`wbCards`; `adv-auto-keywords-stats` → `wbAdvAutoKeywordsStats`;
`adv-fullstats` → `wbAdvFullstats`; `search-texts` → `wbSearchTexts`;
`analytics-by-period` → `wbAnalyticsByPeriod`; `adverts` → `wbAdverts`;
`search-clusters-bids` → `wbSearchClustersBids`.

Особенности:

- `-v/--verbose` (только `ozon-recalculate-expenses`): перед доставкой
  печатает `# inner: <inner-команда>` в stderr — во всех режимах.
- `--ref-fields` с единственным значением эмитится дважды
  (см. «Известные отклонения», preserve).
- Порядок флагов в inner-команде — как в таблице (стабилен).
- Имя `<команда>` в ошибках: `mpu <обёртка>`; у групп с подкомандами —
  имя группы (`mpu wb-loader`, `mpu data-loader`) для всех подкоманд.

## Ввод/вывод

exec-режим: stdout/stderr inner-команды стримятся (одним потоком —
`platform/exec-transport.md`), код выхода наследуется 1:1, собственных
сообщений об успехе нет. print-режимы: единственная строка команды в
stdout + буфер обмена, exit 0. Ошибки — stderr
`<команда>: <причина>` (+ список кандидатов, если есть), exit 2.

## Побочные эффекты

exec-режим — прод-мутация: recalculate/save-expenses пересчитывают и
пишут расчётные данные UNIT клиента за период; `ss-update` запускает
запись в Google-таблицу; `wb-loader` — загрузку из WB API в БД клиента;
`data-loader find-candidate` — серверную операцию поиска кандидата.
print-режимы — без выполнения и сети (кроме чтения кэш-БД при резолве).

## Конфигурация

Всё — через `platform/portainer.md` (env `sl_<N>`, `PG_MY_USER_NAME` —
только ssh-печать), `platform/exec-transport.md` (Portainer) и
`platform/config.md`; собственных ключей у семейства нет.

## Инварианты

- Все обёртки трактуют `SELECTOR`, `--server`, `--print`, `--local`,
  `--client-id` идентично — одна машинерия, не копии по командам.
- Резолв селектора и auto-pick выполняются до печати: набор ошибок
  ввода одинаков в exec- и print-режимах.
- `--sid` никогда не выводится из кандидатов автоматически, даже если
  кабинет единственный, — только явное значение.
- Дефолт `--date-to` вычисляется в момент вызова (сегодняшняя дата) и
  всегда попадает в inner-команду явным токеном.
- Незаданный опциональный флаг не оставляет следа в inner-команде.

## Граничные случаи и ошибки

- Селектор пуст/неоднозначен → тексты и кандидаты
  `platform/selector.md`, exit 2 — в том числе в print-режимах.
- `--client-id` не резолвится → `<команда>: cannot resolve --client-id
  from selector; pass --client-id` + кандидаты, exit 2. Аналогично
  `--spreadsheet-id` у `ss-update`.
- `--sid` (wb-loader) / `--sids` (data-loader) не заданы → ошибка
  обязательной опции CLI-парсера, exit 2.
- Значение флага с shell-небезопасными символами → exit 2
  (`platform/portainer.md`), без сетевых вызовов.
- Inner-команда завершилась ненулевым кодом → тот же код выхода, без
  дополнительных сообщений (stderr дочернего процесса уже отстримлен).
- `--skus` не задан → флаг опущен; задан N раз → один токен
  `[v1,…,vN]`.

## Golden-примеры

Кандидаты — снять при переводе в «к реализации» (все в print-режимах,
на синтетическом конфиге, без выполнения):

- `mpu ss-update <селектор> --print` — happy path ssh-формы;
- `mpu wb-loader cards <селектор> --sid <sid> --print` и
  `… --print --local` — обе формы печати;
- `mpu wb-recalculate-expenses <селектор> --print` — дефолты дат;
- `mpu ozon-recalculate-expenses <селектор> --print -v
  --ref-fields sebes_rub --skus 123` — verbose + дубль ref-fields +
  скобочный литерал;
- `mpu data-loader find-candidate <селектор> --sids abc --print` —
  списочный флаг;
- `mpu wb-loader cards <селектор> --print` без `--sid` — ошибка
  обязательной опции (exit 2);
- вызов с `--client-id 'a b'` — ошибка SafeToken (exit 2).

## Известные отклонения

- **fix** — краткие справки `ss-update`, `wb-recalculate-expenses`,
  `wb-save-expenses`, `ozon-save-expenses` в общем списке команд
  называют командой «печать ssh-команды», тогда как дефолт — выполнение
  в проде. Справка обязана называть дефолт выполнением, `--print` —
  режимом печати.
- **fix** — `--local` без `--print` молча игнорируется и команда
  выполняется в проде. Правильно: exit 2 с текстом `<команда>: --local
  имеет смысл только вместе с --print`.
- **preserve** — `--ref-fields` с единственным значением эмитится
  дважды. Причина: парсер sl-back CLI схлопывает одиночное значение
  повторяемого флага в скаляр, а метод ждёт массив; дубль безопасен
  (повторный ключ поглощается при записи). Контракт нижестоящего
  парсера — вне скоупа переезда.
- **preserve** — `--skus` и `--nm-ids` передаются одним JSON-литералом
  `[1,2,3]`. Причина: парсер sl-back CLI распознаёт целочисленный
  JSON-массив, форма не подвержена схлопыванию. (Три разных обхода
  одного нижестоящего квирка — идея унификации в журнал переезда.)

## Открытые вопросы

нет
