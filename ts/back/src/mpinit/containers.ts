/**
 * Сводка контейнеров после core (`mp-init.md`, «Подъём с нуля», шаг 4,
 * сводка): контейнер в петле рестартов или вышедший с ошибкой — строка
 * `warning:`; код выхода команды она не меняет.
 *
 * Смотрятся только контейнеры compose-проектов каталога mp-config-local
 * (решение хоста 4): иначе в сводку попали бы стенд ozon и чужие проекты.
 */

import type { Docker } from "./docker.ts";

/** Контейнер в беде: имя и состояние в том виде, в каком его печатать. */
interface Trouble {
  readonly name: string;
  readonly state: string;
}

/**
 * Состояние строки `docker ps` (`<имя>\t<Status>`), если это беда.
 * `Exited (0)` — штатное завершение, `*-migrations` проверены раньше.
 */
function troubleOf(line: string): readonly Trouble[] {
  const [name, status = ""] = line.split("\t");
  if (name === "" || name.endsWith("-migrations")) return [];
  if (status.startsWith("Restarting")) return [{ name, state: "Restarting" }];
  const exited = /^Exited \((\d+)\)/.exec(status);
  if (exited === null || exited[1] === "0") return [];
  return [{ name, state: `Exited (${exited[1]})` }];
}

/** Напечатать предупреждение на каждый контейнер в беде. */
export async function reportContainers(
  docker: Docker,
  progress: (line: string) => void,
  configDir: string,
): Promise<void> {
  const listing = await docker.probe(
    [
      "docker",
      "ps",
      "-a",
      "--filter",
      `label=com.docker.compose.project.working_dir=${configDir}`,
      "--format",
      "{{.Names}}\t{{.Status}}",
    ],
    configDir,
  );
  if (listing.code !== 0) {
    progress(`warning: сводка контейнеров не снята (rc=${listing.code})`);
    return;
  }
  const troubles = listing.stdout.split("\n").flatMap(troubleOf);
  for (const trouble of troubles) {
    const logs = await docker.probe(
      ["docker", "logs", "--tail", "1", trouble.name],
      configDir,
    );
    const last = lastLineOf(logs.stdout + logs.stderr);
    progress(`warning: ${trouble.name}: ${trouble.state} — ${last}`);
  }
}

/** Последняя непустая строка лога. */
function lastLineOf(text: string): string {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  return lines.at(-1) ?? "";
}
