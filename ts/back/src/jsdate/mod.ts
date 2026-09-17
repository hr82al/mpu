/**
 * Команда `mpu jsdate` — момент времени машины меткой из 14 цифр
 * (`docs/specs/jsdate.md`).
 */

import { z } from "@zod/zod";
import { defineCommand } from "../command/mod.ts";

const MINUTE_MS = 60_000;

/**
 * Метка `YYYYMMDDhhmmss` момента `nowMs` в поясе со смещением
 * `offsetMinutes` — в форме `Date.getTimezoneOffset()`: минуты, которые
 * прибавляют к местному времени, чтобы получить UTC.
 *
 * Разряды берутся у ISO-представления сдвинутого момента: своё
 * форматирование с ведущими нулями пришлось бы писать по разряду, а
 * `toISOString` даёт их и всегда в UTC — то есть без зависимости от
 * пояса самой машины, который здесь уже учтён сдвигом.
 */
export function jsDateStamp(nowMs: number, offsetMinutes: number): string {
  const local = new Date(nowMs - offsetMinutes * MINUTE_MS);
  return local.toISOString().replace(/\D/g, "").slice(0, 14);
}

const resultSchema = z.object({
  /** 14 цифр местного времени: год, месяц, день, часы, минуты, секунды. */
  stamp: z.string().regex(/^\d{14}$/),
});

export const jsdateCommand = defineCommand({
  path: ["jsdate"],
  summary: "текущий момент меткой YYYYMMDDhhmmss по местному времени",
  usage: "mpu jsdate",
  help: `Печатает текущий момент времени машины 14 цифрами без
разделителей: год, месяц, день, часы, минуты, секунды —
YYYYMMDDhhmmss. Разряды местные, с учётом часового пояса машины (его
переопределяет TZ), а не UTC.

Метка годится для имён файлов, каталогов и суффиксов резервных копий:
в пределах одного пояса её лексикографический порядок совпадает с
хронологическим.

Аргументов и флагов нет; вывод — одна строка с переводом строки в
конце. Тулом MCP-сервера команда не публикуется.

Exit: 0 — успех; 2 — лишний аргумент.

Пример: mpu jsdate → 20260818153456`,
  policy: "ro",
  argsSchema: z.object({}),
  resultSchema,
  run: (_args, _io) => {
    const now = new Date();
    return Promise.resolve({
      stamp: jsDateStamp(now.getTime(), now.getTimezoneOffset()),
    });
  },
  render: (result) => `${result.stamp}\n`,
});
