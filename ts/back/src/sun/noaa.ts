/**
 * Положение Солнца по алгоритму NOAA Solar Calculator
 * (`docs/specs/sun.md`): восход, истинный полдень, закат и длина дня
 * для даты и координат.
 *
 * Формулы — из NOAA General Solar Position Calculations (тот же
 * источник, от которого отталкивается питоновский `astral`); порядок
 * шагов сохранён, чтобы расхождение с эталоном искалось по шагам, а не
 * по всему выражению сразу. Все углы внутри — в градусах, время — в
 * минутах от полуночи локального пояса.
 */

/**
 * Высота центра Солнца в момент восхода и заката: минус 50 угловых
 * минут. Из них 34′ — рефракция у горизонта, 16′ — видимый радиус
 * диска: событием считается касание горизонта верхним краем.
 */
const HORIZON_ALTITUDE = -0.833;

const RAD = Math.PI / 180;

/**
 * Половина суток в минутах. Служит и границей поиска восхода и заката
 * (солнечная полночь по обе стороны от полудня), и базой формулы
 * полудня NOAA — там это те же 720 минут от местной полуночи.
 */
const HALF_DAY_MINUTES = 720;

/**
 * Делений отрезка при поиске горизонта: отрезок в 720 минут после 40
 * половинений сжимается до 4·10⁻⁸ секунды — на семь порядков точнее
 * округления ответа.
 */
const BISECTION_STEPS = 40;

/** Момент дня в минутах от местной полуночи. */
export interface SolarDay {
  readonly sunriseMinutes: number;
  readonly noonMinutes: number;
  readonly sunsetMinutes: number;
  readonly dayLengthMinutes: number;
}

/** Точка и день, для которых считаем. */
export interface SolarQuery {
  /** Широта в градусах; север положителен. */
  readonly latitude: number;
  /** Долгота в градусах; восток положителен. */
  readonly longitude: number;
  /** Смещение пояса в часах; для МСК — 3. */
  readonly timezoneHours: number;
  /** Дата местного пояса. */
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/**
 * Солнце не пересекает горизонт в этот день: полярный день либо
 * полярная ночь. Отдельный класс, потому что это не сбой счёта, а
 * ответ «восхода нет» — и команда печатает на него свой текст.
 */
export class NoSunriseError extends Error {
  override name = "NoSunriseError";
}

/**
 * Восход, полдень и закат местного дня.
 *
 * Положение Солнца берётся **в момент самого события**, а не в местную
 * полночь: за сутки склонение уходит на треть градуса, и однопроходный
 * счёт ошибается тем сильнее, чем дальше событие от полуночи — у
 * московского заката это две минуты. Поэтому полдень ищется как
 * пересечение меридиана (неподвижная точка по уравнению времени), а
 * восход и закат — как корни уравнения «высота центра Солнца равна
 * −0.833°» делением отрезка пополам.
 *
 * Половины дня при этом получаются неравными, и это не ошибка: за день
 * склонение успевает измениться, и утренняя половина отличается от
 * вечерней на десятки секунд.
 */
export function solarDay(query: SolarQuery): SolarDay {
  const midnightJulian = julianDayOf(query) - query.timezoneHours / 24;
  const at = (minutes: number) => altitudeAt(midnightJulian, minutes, query);
  const noon = solarNoonMinutes(midnightJulian, query);
  const sunrise = horizonCrossing(at, noon - HALF_DAY_MINUTES, noon);
  const sunset = horizonCrossing(at, noon + HALF_DAY_MINUTES, noon);
  return {
    sunriseMinutes: sunrise,
    noonMinutes: noon,
    sunsetMinutes: sunset,
    dayLengthMinutes: sunset - sunrise,
  };
}

/**
 * Полдень: момент, когда часовой угол обращается в ноль. Уравнение
 * времени берётся в самом полудне, а не в полночь, — отсюда неподвижная
 * точка. Трёх проходов хватает: поправка на каждом шаге падает на три
 * порядка.
 */
function solarNoonMinutes(midnightJulian: number, query: SolarQuery): number {
  let minutes = HALF_DAY_MINUTES;
  for (let step = 0; step < 3; step++) {
    const century = centuryAt(midnightJulian, minutes);
    minutes = HALF_DAY_MINUTES - 4 * query.longitude -
      equationOfTimeMinutes(century) + query.timezoneHours * 60;
  }
  return minutes;
}

/**
 * Момент пересечения горизонта между полуднем и краем суток. Знак
 * высоты на концах отрезка и решает: солнце не поднялось за целые
 * полсуток — полярная ночь, не опустилось — полярный день.
 */
function horizonCrossing(
  at: (minutes: number) => number,
  edge: number,
  noon: number,
): number {
  const edgeAbove = at(edge) > HORIZON_ALTITUDE;
  const noonAbove = at(noon) > HORIZON_ALTITUDE;
  if (edgeAbove === noonAbove) {
    throw new NoSunriseError(
      noonAbove
        ? "солнце не заходит в этот день на этих координатах"
        : "солнце не восходит в этот день на этих координатах",
    );
  }
  let low = edge;
  let high = noon;
  for (let step = 0; step < BISECTION_STEPS; step++) {
    const middle = (low + high) / 2;
    if ((at(middle) > HORIZON_ALTITUDE) === noonAbove) {
      high = middle;
    } else {
      low = middle;
    }
  }
  return (low + high) / 2;
}

/** Высота центра Солнца в градусах для минуты местного дня. */
function altitudeAt(
  midnightJulian: number,
  minutes: number,
  query: SolarQuery,
): number {
  const century = centuryAt(midnightJulian, minutes);
  const declination = sunDeclination(century);
  const trueSolarMinutes = minutes + equationOfTimeMinutes(century) +
    4 * query.longitude - query.timezoneHours * 60;
  const hourAngle = trueSolarMinutes / 4 - 180;
  const sine = Math.sin(query.latitude * RAD) * Math.sin(declination * RAD) +
    Math.cos(query.latitude * RAD) * Math.cos(declination * RAD) *
      Math.cos(hourAngle * RAD);
  // Зажим — не защитный код: арифметически синус не превосходит
  // единицу, но в double сумма произведений даёт `1 + 2⁻⁵²`, и
  // `Math.asin` на нём возвращает `NaN`. Инвариант «`NaN` в ответе не
  // бывает» не должен зависеть от округления.
  return Math.asin(Math.min(1, Math.max(-1, sine))) / RAD;
}

/** Юлианское столетие для минуты местного дня. */
function centuryAt(midnightJulian: number, minutes: number): number {
  return (midnightJulian + minutes / 1440 - 2451545) / 36525;
}

/** Юлианский день для местной полуночи даты. */
function julianDayOf(query: SolarQuery): number {
  let year = query.year;
  let month = query.month;
  if (month <= 2) {
    year -= 1;
    month += 12;
  }
  const a = Math.floor(year / 100);
  const b = 2 - a + Math.floor(a / 4);
  return Math.floor(365.25 * (year + 4716)) +
    Math.floor(30.6001 * (month + 1)) + query.day + b - 1524.5;
}

/** Склонение Солнца в градусах. */
function sunDeclination(century: number): number {
  const lambda = apparentLongitude(century);
  const obliquity = correctedObliquity(century);
  return Math.asin(
    Math.sin(obliquity * RAD) * Math.sin(lambda * RAD),
  ) / RAD;
}

/** Видимая долгота Солнца с поправкой на нутацию и аберрацию. */
function apparentLongitude(century: number): number {
  const trueLongitude = meanLongitude(century) + equationOfCenter(century);
  return trueLongitude - 0.00569 -
    0.00478 * Math.sin((125.04 - 1934.136 * century) * RAD);
}

/** Средняя долгота Солнца, приведённая к [0, 360). */
function meanLongitude(century: number): number {
  const value = 280.46646 + century * (36000.76983 + century * 0.0003032);
  return ((value % 360) + 360) % 360;
}

/** Средняя аномалия Солнца. */
function meanAnomaly(century: number): number {
  return 357.52911 + century * (35999.05029 - 0.0001537 * century);
}

/** Эксцентриситет земной орбиты. */
function eccentricity(century: number): number {
  return 0.016708634 -
    century * (0.000042037 + 0.0000001267 * century);
}

/** Уравнение центра: поправка на эллиптичность орбиты. */
function equationOfCenter(century: number): number {
  const anomaly = meanAnomaly(century) * RAD;
  return Math.sin(anomaly) *
      (1.914602 - century * (0.004817 + 0.000014 * century)) +
    Math.sin(2 * anomaly) * (0.019993 - 0.000101 * century) +
    Math.sin(3 * anomaly) * 0.000289;
}

/** Наклон эклиптики с поправкой. */
function correctedObliquity(century: number): number {
  const mean = 23 +
    (26 +
        (21.448 -
            century * (46.815 + century * (0.00059 - century * 0.001813))) /
          60) /
      60;
  return mean + 0.00256 * Math.cos((125.04 - 1934.136 * century) * RAD);
}

/** Уравнение времени в минутах. */
function equationOfTimeMinutes(century: number): number {
  const obliquity = correctedObliquity(century);
  const y = Math.tan(obliquity / 2 * RAD) ** 2;
  const longitude = meanLongitude(century) * RAD;
  const anomaly = meanAnomaly(century) * RAD;
  const e = eccentricity(century);
  const value = y * Math.sin(2 * longitude) -
    2 * e * Math.sin(anomaly) +
    4 * e * y * Math.sin(anomaly) * Math.cos(2 * longitude) -
    0.5 * y * y * Math.sin(4 * longitude) -
    1.25 * e * e * Math.sin(2 * anomaly);
  return 4 * value / RAD;
}

/** Длительность из минут: `HH:MM:SS`, без сворачивания в сутки. */
export function duration(minutes: number): string {
  return hms(Math.round(minutes * 60));
}

function hms(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const rest = totalSeconds % 3600;
  return [hours, Math.floor(rest / 60), rest % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}
