/**
 * Снимок входов всех команд до перевода на ключи
 * (`platform/keys-translation.md`, «Проверка полноты и пара»): имя, вид,
 * форма записи в argv, короткая буква, обязательность, умолчание и
 * описание — всё, что объявление команды говорит о входе. Признака stdin
 * в объявлении нет: подстановку stdin называет описание входа.
 *
 * Снимается один раз, до перевода, и дальше не пересобирается: это
 * эталон того, что было, — по нему тест полноты ищет каждому входу адрес
 * в новой схеме. Запуск из `ts/`:
 * `deno run --allow-read --allow-write=back/src/registry/testdata/inputs-before-159.json back/scripts/gen-inputs-snapshot.ts`.
 */

import { commands } from "../src/registry/mod.ts";

const snapshot = commands.map((command) => ({
  path: command.path.join(" "),
  inputs: command.inputs.map((input) => {
    const field = command.argsJsonSchema.properties[input.name];
    return {
      name: input.name,
      kind: input.kind,
      ...(input.form.positional === undefined
        ? {}
        : { positional: input.form.positional }),
      ...(input.form.short === undefined ? {} : { short: input.form.short }),
      ...(input.form.keepsUnknown === true ? { keepsUnknown: true } : {}),
      required: command.requiredInputNames.includes(input.name),
      ...(field.default === undefined ? {} : { default: field.default }),
      description: field.description ?? "",
    };
  }),
}));

const target = new URL(
  "../src/registry/testdata/inputs-before-159.json",
  import.meta.url,
);
await Deno.writeTextFile(target, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(
  `${snapshot.length} команд, ${
    snapshot.reduce((sum, command) => sum + command.inputs.length, 0)
  } входов`,
);
