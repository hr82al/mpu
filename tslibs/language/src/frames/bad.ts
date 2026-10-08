/**
 * Отказ по первому кадру строки (`platform/back-rpc.md`,
 * `platform/call-context.md`). Отдельным листом, а не в `frame.ts`:
 * объекты контекста вызова бросают тот же отказ, а импортировать их
 * `frame.ts` обязан — цикла быть не должно.
 */

/** Отказ на кадр, вид которого клиенту знать незачем. */
export const BAD_FRAME_REPORT = "плохой кадр строки";

/**
 * Первый кадр не разобрался или принёс непринимаемое. Причина
 * (`message`) — для разбирающего сбой, `report` — строка, которую
 * увидит клиент кадром `err` с префиксом `mpu-back: `.
 */
export class BadFrame extends Error {
  override name = "BadFrame";
  readonly report: string;

  /**
   * @param reason причина отказа для разбирающего
   * @param report что сказать клиенту; по умолчанию — «плохой кадр строки»
   */
  constructor(reason: string, report: string = BAD_FRAME_REPORT) {
    super(reason);
    this.report = report;
  }
}
