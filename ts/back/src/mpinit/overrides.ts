/**
 * Сверка override-файлов local-stack с compose стека до `up`
 * (`mp-init.md`, «Подъём с нуля», шаг 4, overrides).
 *
 * Override на сервис, которого в compose уже нет, роняет весь стек
 * (`service "…" has neither an image nor a build context specified`).
 * Лишние сервисы не отфильтровываются молча: расхождение значит, что
 * local-stack отстал, и чинить его надо в файле.
 */

/**
 * Имена сервисов override-файла — ключи с отступом в два пробела под
 * `services:`. Узкий разбор строк, а не YAML (решение хоста: новой
 * зависимости нет): override-файлы local-stack пишутся одним образцом,
 * и комментарии внутри блока — единственная вольность, которую в них
 * видели (фикстура `overrides/`).
 */
export function servicesOf(text: string): readonly string[] {
  const services: string[] = [];
  let inside = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!line.startsWith(" ")) {
      inside = line.trimEnd() === "services:";
      continue;
    }
    const key = /^ {2}([^\s#:][^:]*):/.exec(line);
    if (inside && key !== null) services.push(key[1]);
  }
  return services;
}

/** Сервисы файла, которых нет в compose; пусто — расхождения нет. */
export function strangersOf(
  overrideServices: readonly string[],
  composeServices: readonly string[],
): readonly string[] {
  const known = new Set(composeServices);
  return overrideServices.filter((name) => !known.has(name));
}

/** Сервисы из stdout `docker compose … config --services`. */
export function composeServicesOf(stdout: string): readonly string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}
