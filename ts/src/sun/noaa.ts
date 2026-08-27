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

/** Угол центра Солнца под горизонтом в момент восхода и заката. */
const HORIZON_ANGLE = 90.833;

const RAD = Math.PI / 180;

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
 * Восход, полдень и закат местного дня. Часовой угол не определён —
 * `NoSunriseError`: в этот день солнце либо не заходит, либо не
 * восходит, и печатать вместо времени `NaN` нельзя — это выглядело бы
 * ответом.
 */
export function solarDay(query: SolarQuery): SolarDay {
  const julianDay = julianDayOf(query) - query.timezoneHours / 24;
  const century = (julianDay - 2451545) / 36525;
  const declination = sunDeclination(century);
  const equationOfTime = equationOfTimeMinutes(century);
  const hourAngle = sunriseHourAngle(query.latitude, declination);
  // Истинный полдень: поправка на долготу внутри пояса и на уравнение
  // времени. Всё в минутах — так же, как в таблице NOAA.
  const noon = 720 - 4 * query.longitude - equationOfTime +
    query.timezoneHours * 60;
  return {
    sunriseMinutes: noon - hourAngle * 4,
    noonMinutes: noon,
    sunsetMinutes: noon + hourAngle * 4,
    dayLengthMinutes: hourAngle * 8,
  };
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

/**
 * Часовой угол восхода в градусах. Косинус вне [-1, 1] означает, что
 * горизонта солнце в этот день не пересекает.
 */
function sunriseHourAngle(latitude: number, declination: number): number {
  const cosine = Math.cos(HORIZON_ANGLE * RAD) /
      (Math.cos(latitude * RAD) * Math.cos(declination * RAD)) -
    Math.tan(latitude * RAD) * Math.tan(declination * RAD);
  if (cosine > 1 || cosine < -1) {
    throw new NoSunriseError(
      cosine > 1
        ? "солнце не восходит в этот день на этих координатах"
        : "солнце не заходит в этот день на этих координатах",
    );
  }
  return Math.acos(cosine) / RAD;
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
