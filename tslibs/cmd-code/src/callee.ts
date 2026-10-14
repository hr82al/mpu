/**
 * Имя вызываемого по синтаксису: правила `literals` и `shape` узнают
 * вызов по имени (`describe`, `vi.mock`, `expect`), а не по типу —
 * проекта у них нет.
 */

import type TS from "typescript";

/**
 * Имя вызываемого через точку (`vi.mock`, `screen.getByRole`); у
 * `within(…).getByText` — от вызова дальше. Прочие формы — пусто.
 */
export function calleeName(ts: typeof TS, expression: TS.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const head = calleeName(ts, expression.expression);
    return head === ""
      ? expression.name.text
      : `${head}.${expression.name.text}`;
  }
  return "";
}
