/**
 * `@mpu/invokelog` — журнал вызовов `mpu` без привязки к рантайму
 * (`ts/docs/specs/platform/tslibs-n4.md`, поведение —
 * `platform/invoke-log.md`): одна запись на исполнение команды — что
 * запускали, вывод, ошибки, код, длительность; маскирование секретов,
 * дозапись и ротация файла под локом.
 *
 * Наружу отдаётся ровно прежняя поверхность модуля журнала: сборка журнала
 * (`makeInvokeLog`), журнал, который ничего не пишет (`NO_INVOKE_LOG`), число
 * архивов ротации для команды чтения журнала (`DEFAULT_KEEP`) и типы записи.
 * Маска, формат записи и файл — устройство. Описание каждого имени — JSDoc у
 * его определения.
 */

export {
  DEFAULT_KEEP,
  type InvokeCommand,
  type InvokeLog,
  type InvokeLogDeps,
  type InvokeRecording,
  type LogEnv,
  makeInvokeLog,
  NO_INVOKE_LOG,
  type OutputPolicy,
  type OutputSink,
} from "./src/mod.ts";
