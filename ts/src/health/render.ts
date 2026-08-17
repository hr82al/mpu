/**
 * Вывод `mpu health` (`specs/health.md`, «Ввод/вывод»): заголовок,
 * таблица состояний, блоки one-shot и предупреждений, хвосты логов.
 * Голденов у команды нет и быть не может — весь её живой вывод это
 * состояние прод-фермы, — поэтому форма собрана здесь по тексту спеки.
 */

import { renderTable } from "../ps/table.ts";
import type { HealthResult } from "./run.ts";

/** Весь stdout вызова; блоки разделены пустой строкой. */
export function renderHealth(result: HealthResult): string {
  const blocks: string[] = [
    `=== ${result.server}: ${result.mpCount} mp-* containers ===\n`,
    renderTable(
      ["NAME", "STATE", "STATUS"],
      result.rows.map((row) => [
        row.name,
        row.state,
        row.status,
      ]),
    ),
  ];
  if (result.oneShot.length > 0) {
    blocks.push(
      "✓ One-shot containers (completed normally):\n" +
        result.oneShot
          .map((row) => `  ${row.name}: ${row.status}\n`)
          .join(""),
    );
  }
  if (result.notRunning.length > 0) {
    blocks.push(
      "⚠️  Containers not in 'running' state:\n" +
        result.notRunning
          .map((row) =>
            `  ${row.name}: state=${row.state} status=${row.status}\n`
          )
          .join(""),
    );
  }
  if (result.tails.length > 0) blocks.push(tailBlock(result));
  return blocks.join("\n");
}

/**
 * Хвосты логов. Пустой stderr в окне и сбой получения — разные строки:
 * первое значит «нечего показать», второе — «не удалось спросить», и
 * второе на код выхода не влияет.
 */
function tailBlock(result: HealthResult): string {
  const header = `=== tail --${result.tail} (stderr) for ` +
    `${result.tails.length} container(s) ===\n`;
  return header + result.tails
    .map((tail) => {
      const title = `--- ${tail.name} (stderr, tail=${result.tail}) ---\n`;
      if (tail.error !== null) return `${title}  (logs error: ${tail.error})\n`;
      return tail.text === ""
        ? `${title}  (no stderr in window)\n`
        : `${title}${tail.text}`;
    })
    .join("");
}
