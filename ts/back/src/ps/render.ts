/**
 * Формы вывода `mpu ps` (`specs/ps.md`): таблица, TSV и JSON. Колонка
 * STATUS есть только у живого списка — её отсутствие в кэш-режиме не
 * косметика, а признак того, что данные из снапшота.
 */

import { renderTable } from "./table.ts";
import type { PsResult } from "./run.ts";

/** Вывод по выбранной форме; хвост — один перевод строки. */
export function renderPs(
  result: PsResult,
  form: "table" | "tsv" | "json",
): string {
  const live = result.source === "live";
  const rows = result.containers.map((container) =>
    live
      ? [
        container.name,
        container.state,
        container.status ?? "",
        container.image,
      ]
      : [
        container.endpoint ?? "?",
        container.name,
        container.state,
        container.image,
      ]
  );
  if (form === "json") return json(result);
  if (form === "tsv") {
    return rows.map((row) => `${row.join("\t")}\n`).join("");
  }
  // Пустой живой список — своя строка: у кэш-режима её место занимает
  // строка про пустой кэш в stderr (спека).
  if (live && rows.length === 0) return "(no containers)\n";
  if (rows.length === 0) return "";
  return renderTable(
    live ? ["NAME", "STATE", "STATUS", "IMAGE"] : [
      "ENDPOINT",
      "NAME",
      "STATE",
      "IMAGE",
    ],
    rows,
  );
}

/**
 * JSON: порядок ключей объявлен спекой, отступ — два пробела, кириллица
 * без экранирования, в конце перевод строки.
 */
function json(result: PsResult): string {
  const items = result.containers.map((container) =>
    result.source === "live"
      ? {
        name: container.name,
        state: container.state,
        status: container.status ?? "",
        image: container.image,
      }
      : {
        endpoint: container.endpoint ?? "?",
        name: container.name,
        state: container.state,
        image: container.image,
      }
  );
  return `${JSON.stringify(items, null, 2)}\n`;
}
