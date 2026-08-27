/**
 * Команда `mpu sun` (`docs/specs/sun.md`): восход, полдень, закат и
 * длина дня для точки и даты.
 *
 * Считается локально, без сети: алгоритм NOAA в `noaa.ts`. Часовой
 * пояс ответа фиксирован московским — команда отвечает на вопрос «во
 * сколько сегодня темнеет у нас», а не «который час у солнца».
 */

import { z } from "@zod/zod";
import { defineCommand, DomainError, UsageError } from "../command/mod.ts";
import { localDate } from "../dates/mod.ts";
import {
  duration,
  NoSunriseError,
  type SolarDay,
  solarDay,
  type SolarQuery,
} from "./noaa.ts";

/** Дата в форме ответа и ввода. */
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Пояс ответа: МСК, и он же в поле `timezone`. */
const TIMEZONE_HOURS = 3;
const TIMEZONE_LABEL = "UTC+03:00";

/** Смещение МСК в форме `Date.getTimezoneOffset()`. */
const MSK_OFFSET_MINUTES = -180;

/** Координаты по умолчанию: офис. */
const DEFAULT_LATITUDE = 55.693516;
const DEFAULT_LONGITUDE = 37.967941;

const argsSchema = z.object({
  lat: z.number().default(DEFAULT_LATITUDE).describe(
    "широта в градусах; север положителен",
  ),
  lon: z.number().default(DEFAULT_LONGITUDE).describe(
    "долгота в градусах; восток положителен",
  ),
  date: z.string().optional().describe(
    "дата YYYY-MM-DD; по умолчанию сегодняшняя по Москве",
  ),
});

const resultSchema = z.object({
  date: z.string().describe("дата, для которой посчитано"),
  latitude: z.number(),
  longitude: z.number(),
  timezone: z.string().describe("пояс времён ответа"),
  sunrise: z.string().describe("восход, `YYYY-MM-DD HH:MM:SS`"),
  solar_noon: z.string().describe("истинный полдень"),
  sunset: z.string().describe("закат"),
  day_length: z.string().describe("длина дня, `HH:MM:SS`"),
});

type SunArgs = z.infer<typeof argsSchema>;
type SunResult = z.infer<typeof resultSchema>;

/** Разбор даты ответа: своя форма, а не сообщение схемы. */
function parseDate(raw: string | undefined, nowMs: number): {
  readonly text: string;
  readonly year: number;
  readonly month: number;
  readonly day: number;
} {
  const text = raw ?? localDate(nowMs, MSK_OFFSET_MINUTES);
  const match = DATE.exec(text);
  if (match === null) {
    throw new UsageError(`bad --date '${text}', expected YYYY-MM-DD`);
  }
  const [year, month, day] = match.slice(1).map(Number);
  // Календарь проверяется приведением: `2026-02-31` разберётся
  // регуляркой, но датой не является. Заодно отсекаются годы 0–99:
  // `Date.UTC` отображает их в 19xx, и приведение не сходится — для
  // таких дат григорианская формула юлианского дня всё равно неверна.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new UsageError(`bad --date '${text}', expected YYYY-MM-DD`);
  }
  return { text, year, month, day };
}

/** Счёт дня; сети и часов машины здесь нет, кроме умолчания даты. */
export function sunOf(args: SunArgs, nowMs: number): SunResult {
  const date = parseDate(args.date, nowMs);
  if (args.lat < -90 || args.lat > 90) {
    throw new UsageError(`bad --lat '${args.lat}', expected -90..90`);
  }
  if (args.lon < -180 || args.lon > 180) {
    throw new UsageError(`bad --lon '${args.lon}', expected -180..180`);
  }
  const day = solarDayOrRefuse({
    latitude: args.lat,
    longitude: args.lon,
    timezoneHours: TIMEZONE_HOURS,
    year: date.year,
    month: date.month,
    day: date.day,
  });
  // Момент, а не время суток: у далёкой долготы восход и закат
  // приходятся на соседние московские сутки, и каждый несёт свою дату.
  // Иначе ответ читался бы как «восход позже заката» в один день.
  const at = momentsOf(date, TIMEZONE_HOURS);
  return {
    date: date.text,
    latitude: args.lat,
    longitude: args.lon,
    timezone: TIMEZONE_LABEL,
    sunrise: at(day.sunriseMinutes),
    solar_noon: at(day.noonMinutes),
    sunset: at(day.sunsetMinutes),
    day_length: duration(day.dayLengthMinutes),
  };
}

/** Счёт дня; полярный исход переводится в отказ команды. */
function solarDayOrRefuse(query: SolarQuery): SolarDay {
  try {
    return solarDay(query);
  } catch (err) {
    // Полярный день и ночь — не сбой счёта, а ответ «восхода нет»:
    // доменная ошибка с кодом 1, а не `NaN` в JSON.
    if (err instanceof NoSunriseError) {
      throw new DomainError(err.message, { cause: err });
    }
    throw err;
  }
}

/**
 * Момент местного дня в форме `YYYY-MM-DD HH:MM:SS`. Считается от
 * московской полуночи запрошенной даты, поэтому дата в строке — дата
 * самого момента, а не та, что попросили.
 */
function momentsOf(
  date: { readonly year: number; readonly month: number; readonly day: number },
  timezoneHours: number,
): (minutes: number) => string {
  const midnightUtcMs = Date.UTC(date.year, date.month - 1, date.day) -
    timezoneHours * 3_600_000;
  return (minutes) => {
    const localMs = midnightUtcMs + Math.round(minutes * 60) * 1000 +
      timezoneHours * 3_600_000;
    return new Date(localMs).toISOString().replace("T", " ").slice(0, 19);
  };
}

export const sunCommand = defineCommand({
  path: ["sun"],
  summary: "Восход, полдень, закат и длина дня для точки и даты.",
  usage: "mpu sun [--lat 55.693516] [--lon 37.967941] [--date YYYY-MM-DD]",
  help: `Считает локально, без сети: алгоритм NOAA Solar Calculator.

--lat и --lon — координаты в градусах; по умолчанию офисные
(55.693516, 37.967941). --date — дата YYYY-MM-DD; по умолчанию
сегодняшняя по Москве.

Времена ответа — в московском поясе (UTC+03:00) при любых координатах:
команда отвечает на вопрос «во сколько у нас темнеет», а не «который
час у солнца». Округление — до секунды.

stdout — JSON-объект: date, latitude, longitude, timezone, sunrise,
solar_noon, sunset, day_length.

Exit: 0 — посчитано; 1 — солнце в этот день не пересекает горизонт
(полярный день или ночь); 2 — ошибки ввода.

Примеры: mpu sun; mpu sun --date 2026-12-21;
mpu sun --lat 78.2232 --lon 15.6469 --date 2026-06-21`,
  // Читающая: наружу не ходит и ничего не меняет.
  policy: "ro",
  argsSchema,
  resultSchema,
  run: (args) => Promise.resolve(sunOf(args, Date.now())),
  render: (result: SunResult) => `${JSON.stringify(result, null, 2)}\n`,
});
