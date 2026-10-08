/**
 * Места заголовка вопроса хука (`claude-hook-permission-request.md`,
 * «Payload → форма вопроса»; `claude-hook-stop.md`, «Вопрос „ждёт
 * ввода“»): сессия, проект, окно — одна сборка на оба хука.
 */

/** Место «проект»: базовое имя `cwd` без завершающих слэшей; нет — пусто. */
export function projectOf(cwd: unknown): readonly string[] {
  if (typeof cwd !== "string") return [];
  const name = cwd.replace(/\/+$/, "").split("/").at(-1) ?? "";
  return name === "" ? [] : [name];
}

/** Места по порядку: название сессии, проект, окно tmux. */
export function placesOf(
  title: readonly string[],
  project: readonly string[],
  window: readonly string[],
): readonly string[] {
  return [...title, ...project, ...window];
}
