/**
 * Команда `mpu image sync` в дереве (`image-sync.md`, «CLI-контракт»):
 * справка, варианты, ключи и политика. Исполняет строку ядро — у него
 * образ, правила и снимок дерева (`back/src/line/sync.ts` в `ts/`); до
 * исполнителя из пула строка не доходит.
 */

import { z } from "zod";
import { defineCommand } from "@mpu/command";

/** Путь команды: по нему ядро узнаёт строку синхронизации. */
export const SYNC_PATH: readonly string[] = ["image", "sync"];

/** Аргументы строки `image sync` после разбора цепочкой. */
export const syncArgsSchema = z.object({
  "dry-run": z
    .boolean()
    .default(false)
    .describe("только отчёт: ни база, ни файлы, ни архив не меняются"),
  dir: z
    .string()
    .optional()
    .describe("каталог файлов; умолчание — ключ конфига image.dir"),
  base: z
    .array(z.string())
    .default([])
    .describe(
      "адрес метода получатель.имя: в конфликте права база; повторяется",
    ),
  files: z
    .array(z.string())
    .default([])
    .describe(
      "адрес метода получатель.имя: в конфликте права файл; повторяется",
    ),
  deletes: z
    .enum(["allow"], {
      error: (issue) => `invalid deletes: value "${String(issue.input)}"`,
    })
    .optional()
    .describe("allow — снять предохранитель массового удаления"),
});

/** Аргументы синхронизации. */
export type SyncArgs = z.infer<typeof syncArgsSchema>;

const resultSchema = z.object({
  report: z.string().describe("текст отчёта: строка на метод и итог"),
});

export const imageSyncCommand = defineCommand({
  path: SYNC_PATH,
  keys: {},
  errorName: "image sync",
  summary: "Сводит методы образа с файлами каталога в обе стороны.",
  usage:
    "mpu ask image sync [dry] [dir: КАТАЛОГ] [base: АДРЕС]... " +
    "[files: АДРЕС]... [deletes: allow]",
  help: `Звать после правки файлов методов или перед коммитом каталога \
образа: в отличие от ручного копирования видит, какая сторона изменилась \
с прошлого раза, и ничего не теряет — метод, изменённый с обеих сторон, \
не трогает.

Файл метода — <каталог>/<получатель через />/<имя>.mpu, в нём строка
определения: kiten define: cardsIn: purpose: ^…^ do … done. Сторона,
изменившаяся с прошлой синхронизации, переносится на другую; изменённая
с обеих — строка конфликт, обе стороны прежние. Пустая сторона другую
не удаляет: удаление выводится только по архиву прошлого запуска.

dir: — каталог; умолчание — mpu config key: image.dir. Только
$HOME/mr/mp/mpu/image или под ним.
base: / files: — адрес kiten.cardsIn (получатель.имя без последнего
двоеточия): в конфликте этого метода права база / файл. Повторяются.
deletes: allow — удалить больше половины методов стороны; без него такой
запуск — отказ с готовой строкой.

stdout — строка на метод: действие<TAB>получатель имя (у конфликт —
третьим полем адрес), затем файл не разобран<TAB>путь<TAB>причина,
последней — совпало N, изменено M, конфликтов K. Результат — текст.

Exit: 1 — конфликт, сбой или неразобранный файл; 2 — строка набрана не
так, каталог вне права или массовое удаление.`,
  examples: [
    "mpu ask image sync dry",
    "mpu ask image sync files: kiten.cardsIn",
  ],
  policy: "rw",
  text: true,
  argsSchema: syncArgsSchema,
  resultSchema,
  run: () =>
    Promise.reject(
      new Error("строку image sync исполняет ядро, не исполнитель"),
    ),
  render: (result) => result.report,
});
