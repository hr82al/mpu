/**
 * Состав справок семейства (`specs/code-refs.md`, `specs/code-twins.md`,
 * раздел «CLI-контракт»).
 *
 * Спеки больше не цитируют текст справки — они задают её состав: два
 * источника одного текста расходятся молча, и проверить расхождение
 * нечем. Здесь проверяется ровно то, что спека и требует: справка
 * называет перечисленное, а пример вызова — полный и разбирается.
 */

import { assertEquals } from "@std/assert";
import { parseAddress } from "./address.ts";
import { codeRefsCommand } from "./cmd_refs.ts";
import { codeTwinsCommand } from "./cmd_twins.ts";
import { codeNameCommand } from "./cmd_name.ts";
import { parseWindow } from "./cmd_name.ts";

/** Что справка обязана назвать; по фразе на пункт состава. */
const REQUIRED: Readonly<Record<string, readonly string[]>> = {
  "code refs": [
    // форма адреса и обе его цели
    "[РЕПОЗИТОРИЙ:]ПУТЬ[:СТРОКА]",
    "потребители",
    "читающие модуль",
    // единица перечня — файл, а не обращение
    "Обращения внутри файла местами не считаются",
    // область видимости и раздел «не разрешено»
    "область видимости",
    "не разрешено",
    // значение и умолчание предела
    "--limit N",
    "предел записей в разделе, не строк",
    "по умолчанию 200",
    // коды выхода — перечнем, а не наличием раздела
    "0 —",
    "1 —",
    "2 —",
  ],
  "code twins": [
    "[РЕПОЗИТОРИЙ:]ПУТЬ:СТРОКА",
    "объявления-функции, охватывающего эту строку",
    "побайтово",
    "похоже",
    // правило нормализации «похожих» — все четыре его действия
    "комментарии сняты",
    "пробелы сжаты",
    "переименованы по порядку появления",
    "литералы заменены позиционными метками",
    "не разрешено",
    "--limit N",
    "предел записей в разделе, не строк",
    "по умолчанию 200",
    "0 —",
    "1 —",
    "2 —",
  ],
  "code name": [
    // форма окна и что без него отвечает каждый репозиторий
    "РЕПОЗИТОРИЙ либо РЕПОЗИТОРИЙ:КАТАЛОГ",
    "Без --in отвечает КАЖДЫЙ репозиторий",
    // состав строк объявления и строка типов возврата
    "сигнатура как",
    "область видимости",
    "объявления любой формы",
    "двух и более вызываемых",
    "не разрешено",
    "--limit N",
    "предел записей в разделе, не строк",
    "по умолчанию 200",
    "0 —",
    "1 —",
    "2 —",
  ],
};

const COMMANDS = [codeRefsCommand, codeTwinsCommand, codeNameCommand];

Deno.test("справка называет весь состав, заданный спекой", async (t) => {
  for (const command of COMMANDS) {
    const name = command.path.join(" ");
    await t.step(name, () => {
      const required = REQUIRED[name];
      // Проверка задумана как гейт для будущих поверхностей семейства:
      // без этой строки команда вне таблицы падала бы `TypeError`, а не
      // сообщением о том, что состав её справки не описан.
      assertEquals(
        required !== undefined,
        true,
        `${name}: состав справки не описан`,
      );
      for (const phrase of required) {
        assertEquals(
          command.help.includes(phrase),
          true,
          `${name}: справка не называет «${phrase}»`,
        );
      }
    });
  }
});

Deno.test("пример вызова из справки — полный и разбирается", async (t) => {
  for (const command of COMMANDS) {
    const name = command.path.join(" ");
    await t.step(name, () => {
      const examples = examplesIn(command.help, name);
      assertEquals(examples.length > 0, true, `${name}: примеров нет вовсе`);
      for (const example of examples) {
        // Существования адреса и окна на диске не требуется: пример,
        // ссылающийся на живой исходник, устаревает от первой же правки
        // (`specs/code-twins.md`, «CLI-контракт»). Требуется, чтобы он
        // был полным вызовом и чтобы его адрес либо окно разбирались.
        const tail = example.slice(`mpu ${name} `.length).split(" ");
        if (name === "code name") {
          // Пример без окна проверять нечем: `--in` обязан быть в нём и
          // обязан нести значение, иначе разбор молча уходит в имя.
          const at = tail.indexOf("--in");
          assertEquals(at >= 0, true, `${name}: в примере нет --in`);
          assertEquals(
            at + 1 < tail.length,
            true,
            `${name}: у --in нет значения`,
          );
          parseWindow(tail[at + 1]);
          continue;
        }
        parseAddress(tail[0]);
      }
    });
  }
});

/** Строки справки, начинающиеся с полного вызова этой команды. */
function examplesIn(help: string, name: string): readonly string[] {
  return help.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`mpu ${name} `));
}
