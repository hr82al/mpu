/**
 * Стенд строк образа (`image-sync.md`, `image-export.md`, «Сценарии»):
 * `HOME` во временном каталоге, `$H/mr/mp/mpu` создан заранее, Kaiten
 * подменён; «три метода» и одна синхронизация — готовыми шагами.
 */

import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { Image } from "../image/mod.ts";
import { openRegistryBook } from "./seeds.ts";
import { imaging, withState } from "./testimage.ts";
import { type Ran, runOnStand, withStand } from "./testprogram.ts";
/** «Три метода» стенда — определены строками с ответом `y`. */
const THREE = [
  "ask kiten define: cardsIn purpose: ^мои в колонке^ keys: ^id колонки^ do :col kiten ls where: column is: @col done",
  "ask kiten define: mine purpose: ^мои^ do kiten ls done",
  "ask kiten define: shipped purpose: ^готово^ do kiten ls where: column is: Готово done",
];

/** Строка запуска без оговорок и её вопрос. */
export const SYNC = "ask image sync";
export const QUESTION = "выполнить mpu image sync? [y/N] ";

/** Файл `cardsIn:` — как в «Файл метода». */
export const CARDS_IN_FILE =
  "kiten define: cardsIn: purpose: ^мои в колонке^ keys: ^id колонки^ do :col kiten ls where: column is: @col done\n";

export const FIRST =
  "новый файл\tkiten cardsIn:\nновый файл\tkiten mine\nновый файл\tkiten shipped\n" +
  "совпало 0, изменено 3, конфликтов 0\n";

/** Что строке задают сверх слов. */
export interface Asked {
  readonly answers?: readonly string[];
  readonly cwd?: string;
  readonly terminal?: boolean;
}

/** Стенд синхронизации. */
export interface Sync {
  /** `HOME` стенда. */
  readonly home: string;
  /** Каталог образа по умолчанию, `$H/mr/mp/mpu/image`. */
  readonly dir: string;
  readonly policy: string;
  readonly imageFile: string;
  /** Строка словами через пробел или готовыми словами. */
  run(line: string | readonly string[], asked?: Asked): Promise<Ran>;
  /** «Три метода». */
  three(): Promise<void>;
  /** «Три метода» и один запуск с `y`. */
  synced(): Promise<void>;
}

function words(line: string): string[] {
  return line.split(" ");
}

export async function withSync(body: (sync: Sync) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    await mkdir(`${home}/mr/mp/mpu`, { recursive: true });
    await withState(({ policy, image: imageFile }) =>
      withStand(async (stand) => {
        const run = async (
          line: string | readonly string[],
          asked: Asked = {},
        ) => {
          // Образ открывается строкой заново: тест удаляет и портит файл.
          using image = Image.at(imageFile);
          const said = typeof line === "string" ? words(line) : line;
          return await runOnStand(policy, said, stand, {
            image: imaging(image),
            answers: asked.answers ?? ["y"],
            io: {
              env: (name) => name === "HOME" ? home : undefined,
              cwd: () => asked.cwd ?? "/stand",
              stdinIsTerminal: () => asked.terminal ?? true,
            },
          });
        };
        const three = async () => {
          for (const line of THREE) {
            const ran = await run(line);
            expect(ran.exit, ran.stderr).toBe(0);
          }
        };
        await body({
          home,
          dir: `${home}/mr/mp/mpu/image`,
          policy,
          imageFile,
          run,
          three,
          synced: async () => {
            await three();
            expect((await run(SYNC)).stdout).toStrictEqual(FIRST);
          },
        });
      })
    );
  } finally {
    await rm(home, { recursive: true });
  }
}

/** Файлы каталога: путь от него → текст. */
export async function tree(dir: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  const walk = async (sub: string) => {
    let entries;
    try {
      entries = await readdir(`${dir}${sub}`, { withFileTypes: true });
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") {
        return;
      }
      throw err;
    }
    for (const entry of entries) {
      const path = `${sub}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else found[path.slice(1)] = await readFile(`${dir}${path}`, "utf8");
    }
  };
  await walk("");
  return found;
}

export function ruleOf(
  policy: string,
  path: string,
): string | null | undefined {
  using book = openRegistryBook(policy);
  return book.list().find((rule) => rule.path === path)?.verdict;
}

/** Итог строки: код, stdout — для сверки одной записью. */
export function outcome(ran: Ran): [number, string] {
  return [ran.exit, ran.stdout];
}

/** Файлы и образ побайтово: «ничего не изменено». */
export async function snapshot(sync: Sync): Promise<unknown> {
  return {
    files: await tree(sync.dir),
    image: new Uint8Array(await readFile(sync.imageFile)),
  };
}

/** Конфликт сценария 5: назначение изменено и в файле, и в базе. */
export async function conflicted(sync: Sync) {
  await sync.synced();
  const path = `${sync.dir}/kiten/cardsIn:.mpu`;
  await writeFile(
    path,
    CARDS_IN_FILE.replace("^мои в колонке^", "^мои карточки^"),
  );
  const redefined = await sync.run(
    "ask kiten define: cardsIn purpose: ^x^ keys: ^id колонки^ do :col kiten ls where: column is: @col done",
  );
  expect(redefined.exit, redefined.stderr).toBe(0);
}
