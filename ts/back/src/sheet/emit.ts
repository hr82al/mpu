/**
 * Печать запросов Sheets API (`docs/specs/sheet-batch.md`,
 * «Ввод/вывод»): JSON с отступом 2 и unicode как есть.
 *
 * Единственная тонкость — доли цвета. Целое значение доли (`0`, `1`)
 * обязано печататься как `0.0` и `1.0`: так его печатает рабочая
 * версия, и голден снят с неё. Обычный `JSON.stringify` дробную форму
 * теряет, поэтому доля уходит обёрткой, печатающей заданные символы.
 *
 * Обёртка объявлена здесь, а не взята у соседа (`src/slback/`): тот
 * атом — про sl-back, и зависимость `sheet` → `slback` была бы дикой
 * ради десяти строк объявления.
 */

/** Возможность JSON, которой ещё нет в типах стандартной библиотеки. */
interface JsonWithRaw {
  readonly rawJSON: (text: string) => unknown;
}

const json = JSON as unknown as JsonWithRaw;

/**
 * Доля 0..1 в питоновской форме: целое печатается с `.0`, дробное —
 * кратчайшим представлением (у JS и Python оно совпадает).
 */
export function fraction(value: number): unknown {
  return json.rawJSON(Number.isInteger(value) ? value.toFixed(1) : `${value}`);
}

/** Печать значения: отступ 2, unicode как есть, перевод строки в конце. */
export function printJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
