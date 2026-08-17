/**
 * Куда уходит вызов `mpu run-js` (`specs/run-js.md`, «CLI-контракт»):
 * один селектор, все инстанс-серверы кэша либо контейнеры по подстроке
 * имени. Метка таргета — то, чем он назван в служебных строках и в
 * блоке `--dry-run`.
 */

import { UsageError } from "../command/mod.ts";
import {
  ambiguous,
  containerLocations,
  containerNamesLike,
  type ExecPlace,
  instanceServerNumbers,
  placeOf,
  type PlaceSources,
} from "../exec/mod.ts";

/** Таргет вызова вместе с его меткой. */
export interface Target {
  readonly label: string;
  readonly place: ExecPlace;
}

/** Как назван таргет в выводе: `sl-N` / `dev:N` / имя контейнера. */
export function labelOf(place: ExecPlace): string {
  switch (place.kind) {
    case "server":
      return `sl-${place.serverNumber}`;
    case "dev":
      return `dev:${place.serverNumber}`;
    case "container":
      return place.location.containerName;
  }
}

/** Что задал пользователь: ровно один из трёх способов адресации. */
export type Scope =
  | { readonly kind: "one"; readonly selector: string }
  | { readonly kind: "all" }
  | { readonly kind: "containers"; readonly filter: string };

/**
 * Таргеты вызова. Пустая выборка — ошибка ввода со своей подсказкой:
 * кэш наполняет `mpu init`, и без него fan-out целиться некуда.
 */
export function targetsOf(
  scope: Scope,
  sources: PlaceSources,
): readonly Target[] {
  if (scope.kind === "one") {
    const place = placeOf(scope.selector, sources);
    return [{ label: labelOf(place), place }];
  }
  if (scope.kind === "all") {
    const numbers = instanceServerNumbers(sources.cache);
    if (numbers.length === 0) {
      throw new UsageError(
        "в SQLite-кэше нет sl-N (N>0); запусти `mpu init`",
      );
    }
    return numbers.map((serverNumber) => ({
      label: `sl-${serverNumber}`,
      place: { kind: "server", serverNumber } as const,
    }));
  }
  const names = containerNamesLike(sources.cache, scope.filter);
  if (names.length === 0) {
    throw new UsageError(
      `контейнеры с подстрокой '${scope.filter}' не найдены в кэше;` +
        " запусти `mpu init`",
    );
  }
  return names.map((name) => ({
    label: name,
    place: containerPlace(name, sources),
  }));
}

/**
 * Контейнер по имени из той же выборки: строка кэша есть по построению,
 * а несколько — та же неоднозначность, что и у точного имени
 * (`specs/ssh.md`), и обход на ней прерывается.
 */
function containerPlace(name: string, sources: PlaceSources): ExecPlace {
  const locations = containerLocations(sources.cache, name);
  if (locations.length > 1) throw ambiguous(name, locations);
  return { kind: "container", location: locations[0] };
}
