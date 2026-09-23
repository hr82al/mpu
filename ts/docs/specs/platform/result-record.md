# Запись результата: команда, отдающая одну сущность

Статус: к реализации — порция 166b (после 166, до 167).

## Назначение

Живьём после установки 166: `kiten ls … each: do :c kiten card id: @c id end
title print done` → «запись не понимает title; ближайшие: view, card,
propertyNames». Результат `kiten card` — конверт (`{view, card, …}`), а
отбор и программа видят конверт, а не карточку; в однокомандной строке `mpu
kiten card id: 1 end title` — «не понимает title; есть: json, md, first, …»
(конверт принят за коллекцию). `end json` при этом печатает саму карточку.
Команда, чей результат — одна сущность, объявляет её так же, как коллекция
объявляет `items` (`collection-protocol.md`).

## Контракт

- Объявление `record`: «результат → запись» (одна сущность). Запись — то, что
  печатает `end json` команды (для `kiten card` — карточка с полями `id`,
  `title`, `state`, `column`, `comments`, …).
- Результат команды с `record` — запись: поля унарными, `pick:`, форматы
  команды — как прежде; коллекционных сообщений (`size`, `first` …) у неё нет.
- Команда без `items` и без `record` — как сейчас.
- Какие команды объявляют `record`: каждая, чей `end json` печатает один
  объект сущности, а структурный результат — конверт. Исполнитель перечисляет
  их в отчёте (обход — субагентом), спорные решает хост. Обязательно:
  `kiten card`, `mr view`, `sheet get` (если конверт).
- Решено хостом по обходу: `record` — `kiten card`, `kiten time status` (запись
  = собранный объект `end json`: `card_id`, `timer`, `total_minutes`). Не
  объявляют: `mr view`, `mr show`, `sheet get`, `sheet resolve`, `sun`, `xlsx
  get`, `logs` (`end json` — результат целиком); `api ss-access …`, `api
  wb-cards-reset`, `api wb-loader-*` (ответ сервера — любой JSON).
- Одно правило: отбор видит то, что печатает `end json`. Поэтому в эту же
  порцию `items` объявляют команды, чей `end json` — массив под-поля: `config`
  (entries), `glab-status` (rows), `kiten status` (rows), `mr comments`
  (threads), `mr diff` и `mr files` (files), `sheet ls` (tabs), `api
  wb-loader-resume` (entries).
- Поле записи-коллекции (`comments` у карточки) — коллекция: `@c comments
  size`.

## Граничные случаи

| Строка | Ожидается |
|---|---|
| `mpu kiten card id: 67485366 end title` | название карточки |
| `mpu kiten card id: 67485366 end comments size` | число комментариев |
| `mpu kiten card id: 67485366 end size` | «запись не понимает size; ближайшие: …», код 2 |
| `kiten ls first: 2 end each: do :c kiten card id: @c id end title print done` | два названия |
| `mpu kiten card id: 67485366` и `… end json` | как до порции (голдены) |
| `x := kiten card id: 67485366 . x state` | `done` |

## Известные отклонения

Нет.

## Открытые вопросы

Нет.

## Пункты чек-листа

`design.md`: 1 — изменил: результат-сущность — запись со своими полями. 2 —
изменил: коллекция и запись — две реализации одного объявления вида. 3–6 —
ничего нового.

`design-mpu.md`: 4 — изменил: вид результата — одно объявление у команды.
Прочие — ничего.
