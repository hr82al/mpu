/**
 * Отчёт `image sync` (`image-sync.md`, «Отчёт»): `stdout` итога строками,
 * как напечатаны. Строка `конфликт` несёт адрес третьим полем — фронт его
 * берёт как есть и правила адреса не знает.
 */

/** Строка отчёта — данные границы. */
export type ReportLine =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "conflict";
      readonly text: string;
      /** Метод, как его печатает отчёт: `kiten cardsIn:`. */
      readonly method: string;
      /** Адрес для `base:`/`files:`: `kiten.cardsIn`. */
      readonly address: string;
    };

const CONFLICT = "конфликт";

/** Строки отчёта из `stdout`; пуст — строк нет. */
export function reportLines(stdout: string): ReportLine[] {
  return stdout
    .split("\n")
    .filter((text) => text !== "")
    .map((text) => {
      const [action, method, address] = text.split("\t");
      if (action !== CONFLICT || address === undefined) {
        return { kind: "text", text };
      }
      return { kind: "conflict", text, method, address };
    });
}
