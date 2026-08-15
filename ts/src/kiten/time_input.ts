/**
 * Разбор входа команд учёта времени (`docs/specs/kiten-time.md`,
 * «CLI-контракт»): длительность и календарная дата.
 *
 * Модуль чист — ни сети, ни диска, ни часов. Отдельно от команд он лежит
 * потому, что обе формы нужны и подкомандам таймера: `--time` у `stop` —
 * та же длительность с другим именем аргумента. Московская зона живёт
 * рядом, в `./msk.ts`.
 */

import { UsageError } from "../command/mod.ts";

/** Перечень принятых форм — он же хвост двух текстов отказа. */
const DURATION_FORMS = "3h | 1h15m | 1:15 | 90 (минуты) | 2.5h";

/** Верхняя граница одной записи: сутки в минутах. */
const MAX_MINUTES = 1440;

/** Форма `Ч:ММ`; минуты проверяются отдельно — у них свой текст отказа. */
const CLOCK_FORM = /^(\d+):(\d{1,2})$/;

/**
 * Число с необязательной дробью и необязательной единицей измерения.
 * Липкий (`y`) — разбор идёт по позициям; `lastIndex` присваивается перед
 * каждым `exec`, и разделяемым состоянием он не становится: код
 * синхронный и между присваиванием и вызовом ничего не происходит.
 */
const DURATION_TOKEN = /(-?\d+(?:[.,]\d+)?)([hmчм])?/y;

/** Календарный день: только эта форма, без времени и без иных разделителей. */
const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Длительность в целых минутах, 1..1440. `argName` — имя аргумента, через
 * который значение пришло (`DURATION` у позиционного, `--time` у флага):
 * оно стоит в начале каждого отказа, чтобы человек знал, что чинить.
 * Отказ — ошибка ввода: сети команда на этом шаге ещё не касалась.
 */
export function parseDuration(input: string, argName: string): number {
  const compact = input.replace(/\s+/g, "").toLowerCase();
  if (compact === "") {
    throw durationError(
      input,
      argName,
      `пустая длительность; ожидается ${DURATION_FORMS}`,
    );
  }
  const minutes = compact.includes(":")
    ? clockMinutes(compact, input, argName)
    : unitMinutes(compact, input, argName);
  return checkedRange(minutes, input, argName);
}

/**
 * Календарный день `YYYY-MM-DD`; иное — ошибка ввода с именем флага.
 * Несуществующий день (`2026-02-30`) отвергается вместе с непохожими на
 * дату строками: сервер записал бы его как соседний, и запись уехала бы
 * на день, которого пользователь не называл.
 */
export function parseCalendarDate(input: string, flag: string): string {
  const parts = CALENDAR_DAY.exec(input);
  if (parts === null || !isRealDay(parts)) {
    throw new UsageError(`${flag}='${input}': ожидается YYYY-MM-DD`);
  }
  return input;
}

/** Форма `Ч:ММ`: минуты вне 00–59 — свой текст, а не «неразобранная». */
function clockMinutes(
  compact: string,
  input: string,
  argName: string,
): number {
  const parts = CLOCK_FORM.exec(compact);
  if (parts === null) throw unparsedDuration(input, argName);
  const minutes = Number(parts[2]);
  if (minutes > 59) {
    throw durationError(
      input,
      argName,
      "минуты в форме Ч:ММ должны быть 00–59",
    );
  }
  return Number(parts[1]) * 60 + minutes;
}

/**
 * Формы с единицами и голое число. Голое число — минуты, но только когда
 * оно и есть весь вход: `1h15` иначе молча значило бы «1 час 15 минут» у
 * одного читателя и «1 час 15 часов» у другого.
 */
function unitMinutes(
  compact: string,
  input: string,
  argName: string,
): number {
  const used = new Set<string>();
  let total = 0;
  let position = 0;
  while (position < compact.length) {
    DURATION_TOKEN.lastIndex = position;
    const token = DURATION_TOKEN.exec(compact);
    if (token === null) throw unparsedDuration(input, argName);
    const value = Number(token[1].replace(",", "."));
    const ends = DURATION_TOKEN.lastIndex === compact.length;
    // Минус значим только у одиночного числа: `-5` обязано дойти до
    // проверки диапазона со своим текстом, а `1h-15m` формой спеки не
    // является и суммой быть не должно.
    if (value < 0 && position !== 0) throw unparsedDuration(input, argName);
    const unit = token[2];
    if (unit === undefined) {
      if (position !== 0 || !ends) {
        throw missingUnit(input, argName, used, ends, compact);
      }
      total += value;
    } else {
      const kind = unit === "h" || unit === "ч" ? "h" : "m";
      // Единица не чаще раза: `1h2h` — не сумма, а опечатка, и какая
      // именно, команде не известно.
      if (used.has(kind)) throw unparsedDuration(input, argName);
      used.add(kind);
      total += kind === "h" ? value * 60 : value;
    }
    position = DURATION_TOKEN.lastIndex;
  }
  return total;
}

/**
 * Число без единицы там, где она нужна. Подсказка «вероятно, вы имели в
 * виду» даётся, только когда она и правда чинит вход: число завершает
 * строку и минуты ещё не названы. Буква берётся из алфавита уже
 * встреченных единиц — иначе к `1ч15` подсказалось бы латинское `1ч15m`,
 * которое не разбирается.
 */
function missingUnit(
  input: string,
  argName: string,
  used: ReadonlySet<string>,
  ends: boolean,
  compact: string,
): UsageError {
  if (!ends || used.has("m")) return unparsedDuration(input, argName);
  const letter = /[чм]/.test(compact) ? "м" : "m";
  return durationError(
    input,
    argName,
    `после числа нужна единица измерения — вероятно, вы имели в виду '${input.trim()}${letter}'`,
  );
}

/**
 * Округление вверх до минуты и границы диапазона. Перед округлением
 * снимается шум двоичной дроби: `1.1 × 60` даёт 66.00000000000001, и без
 * этого ровный час с десятыми превращался бы в лишнюю минуту.
 */
function checkedRange(minutes: number, input: string, argName: string): number {
  const rounded = Math.ceil(Math.round(minutes * 1e6) / 1e6);
  if (rounded <= 0) {
    throw durationError(input, argName, "нулевая длительность бессмысленна");
  }
  if (rounded > MAX_MINUTES) {
    throw durationError(
      input,
      argName,
      "больше 24 ч в одной записи; заведите записи по дням через --date",
    );
  }
  return rounded;
}

function unparsedDuration(input: string, argName: string): UsageError {
  return durationError(
    input,
    argName,
    `неразобранная длительность; ожидается ${DURATION_FORMS}`,
  );
}

/** Отказ разбора длительности: имя аргумента, сам вход, причина. */
function durationError(
  input: string,
  argName: string,
  reason: string,
): UsageError {
  return new UsageError(`${argName} '${input}': ${reason}`);
}

/** Существует ли такой день: `2026-02-30` формой не отличается от настоящего. */
function isRealDay(parts: RegExpExecArray): boolean {
  const [year, month, day] = [parts[1], parts[2], parts[3]].map(Number);
  const stamp = new Date(Date.UTC(year, month - 1, day));
  return stamp.getUTCFullYear() === year &&
    stamp.getUTCMonth() === month - 1 &&
    stamp.getUTCDate() === day;
}
