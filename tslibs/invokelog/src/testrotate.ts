/**
 * Процесс-ротатор для теста межпроцессной ротации журнала
 * (`platform/node-runtime.md`, [S.7]): дописывает `count` записей
 * `<метка> <номер>` с порогом `maxBytes`, ротируя журнал по ходу.
 *
 * Аргументы: путь журнала, метка, число записей, порог в байтах.
 * Модуль запускают только тесты.
 */

import process from "node:process";
import { appendRecord } from "./file.ts";

/** Архивов с запасом: ни одна запись теста не вытесняется. */
const KEEP = 100;

const [path, label, count, maxBytes] = process.argv.slice(-4);
for (let index = 0; index < Number(count); index++) {
  await appendRecord(path, `${label} ${index}\n`, {
    maxBytes: Number(maxBytes),
    keep: KEEP,
  });
}
