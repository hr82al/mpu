/**
 * Стенд образа для тестов и пересборки голденов `testdata/image/`
 * (`platform/image.md`, «Golden-примеры»): правила и образ во временном
 * каталоге, часы постоянные, Kaiten подменён.
 */

import { Image } from "../image/mod.ts";
import type { ImagePorts } from "./mod.ts";
import { runOnStand, withStand } from "./testprogram.ts";

/** Каталог голденов образа. */
export const IMAGE_DIR = new URL("./testdata/image/", import.meta.url);

/** Определение метода голденов. */
export const CARDS_IN =
  "ask kiten define: cardsIn purpose: ^мои в колонке^ keys: ^id колонки^ " +
  "do :col kiten ls where: column is: @col done";

/** Время определения на стенде. */
export const DEFINED_AT = "2026-09-23T10:00:00.000Z";

/** Файлы правил и образа во временном каталоге на время `body`. */
export async function withState(
  body: (state: { policy: string; image: string }) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await body({ policy: `${dir}/policy.db`, image: `${dir}/image.db` });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/**
 * Порты образа: файл, автор `human`, постоянные часы; изменения образа
 * копятся в `changes`.
 */
export function imaging(image: Image, changes: string[] = []): ImagePorts {
  return {
    image,
    author: "human",
    now: () => new Date(DEFINED_AT),
    changed: () => {
      changes.push("changed");
      return Promise.resolve();
    },
  };
}

/** Голдены образа: имя файла → снятый stdout. */
export async function imageGoldens(): Promise<Record<string, string>> {
  const taken: Record<string, string> = {};
  await withState(({ policy, image: file }) =>
    withStand(async (stand) => {
      using image = Image.at(file);
      const ports = imaging(image);
      const run = (line: string, answers: readonly string[] = []) =>
        runOnStand(policy, line.split(" "), stand, { image: ports, answers });
      await run(CARDS_IN, ["y"]);
      taken["messages.txt"] = (await run("kiten messages")).stdout;
      taken["help.txt"] = (await run("kiten cardsIn: help")).stdout;
    })
  );
  return taken;
}
