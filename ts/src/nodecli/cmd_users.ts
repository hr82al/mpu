/**
 * Группа `mpu users` (`docs/specs/portainer-wrappers.md`): заведение
 * пользователей sl-back и выдача им ролей.
 *
 * Раскладка argv — `selector-first`: селектор и режимы печати
 * набираются до имени подкоманды (признак объявлен у группы в
 * реестре). Клиента ни один из двух методов не знает: пользователь
 * принадлежит серверу.
 */

import { z } from "@zod/zod";
import { type Command, defineCommand } from "../command/mod.ts";
import {
  commonArgsOf,
  renderWrap,
  resultSchema,
  runWrap,
  targetArgs,
  type WrapIo,
} from "./run.ts";

const addArgs = z.object({
  ...targetArgs,
  email: z.string().describe("почта пользователя: обязательна"),
  id: z.string().optional().describe("id пользователя"),
  user: z.string().optional().describe("логин"),
  name: z.string().optional().describe("имя"),
  password: z.string().optional().describe("пароль"),
  "is-active": z.boolean().optional().describe("признак активности"),
});

const addRoleArgs = z.object({
  ...targetArgs,
  id: z.string().describe("id пользователя: обязателен"),
  role: z.string().describe("роль: обязательна"),
});

/** Общая часть справки обеих подкоманд. */
const DELIVERY = `Селектор и режимы печати набираются ДО имени
подкоманды: mpu users sl-1 add. Имя подкоманды перед селектором —
ошибка ввода.

-p/--print ничего не выполняет: печатает готовую ssh-команду и копирует
её в буфер обмена. --local вместе с -p печатает форму локального стенда
(без ssh); сам по себе --local — ошибка ввода.

SELECTOR — сам сервер (sl-N) либо клиент, по которому он находится.
--client-id у этих команд нет: пользователь принадлежит серверу.

Значения флагов проверяются до сети и до печати: допустимы только
A-Za-z0-9 и _ . / : - , @ [ ] — пробел или кавычка это ошибка ввода.

Exit: код inner-команды при выполнении; 0 при печати; 2 — ошибки ввода,
резолва и конфигурации.`;

/** Обе подкоманды группы в порядке объявления. */
export const usersCommands: readonly Command[] = [usersAdd(), usersAddRole()];

function usersAdd(): Command {
  return defineCommand({
    path: ["users", "add"],
    summary: "Завести пользователя sl-back на сервере.",
    usage:
      "mpu users [-p [--local]] SELECTOR add --email E [--server sl-N] [--id I] [--user U] [--name N] [--password P] [--is-active]",
    help: `По умолчанию команда ВЫПОЛНЯЕТСЯ в прод-контейнере сервера:
запускает \`node cli service:users add\` и стримит его вывод, код выхода
наследуется 1:1. Пользователь заводится сразу.

${DELIVERY}

--email обязателен, остальные флаги необязательны и незаданными следа
в inner-команде не оставляют. --is-active уходит голым флагом.

Ни аргументы, ни вывод этой команды в журнал вызовов не пишутся: среди
аргументов пароль (--password), а в режиме -p он же виден в
напечатанной строке. В записи журнала аргументы заменены на REDACTED,
секции вывода нет вовсе, и сообщения разбора ввода не эхо-печатают
введённое.

Пример: mpu users -p sl-1 add --email test@example.com`,
    policy: "rw",
    helpWhenBare: true,
    errorName: "users",
    // Среди аргументов пароль: в журнал вызовов они не идут
    // (`platform/invoke-log.md`, тот же приём, что у `telegram log`).
    logsArguments: false,
    // И вывод тоже: в режиме печати stdout — это собранная команда, а
    // в ней тот же пароль. Маска аргументов без этого закрывала бы
    // парадную дверь при открытой чёрной (приём `mpu mcp token`).
    logsOutput: false,
    argsSchema: addArgs,
    forms: { selector: { positional: "one" }, print: { short: "p" } },
    resultSchema,
    run: (args, io: WrapIo) =>
      runWrap(
        {
          service: "users",
          method: "add",
          clientId: "none",
          flags: () => [
            { name: "email", value: args.email },
            { name: "id", value: args.id },
            { name: "user", value: args.user },
            { name: "name", value: args.name },
            { name: "password", value: args.password },
            { name: "is-active", value: args["is-active"] },
          ],
        },
        commonArgsOf(args),
        io,
      ),
    render: renderWrap,
    textExitCode: (result) => result.exitCode,
  });
}

function usersAddRole(): Command {
  return defineCommand({
    path: ["users", "add-role"],
    summary: "Выдать роль пользователю sl-back.",
    usage:
      "mpu users [-p [--local]] SELECTOR add-role --id I --role R [--server sl-N]",
    help: `По умолчанию команда ВЫПОЛНЯЕТСЯ в прод-контейнере сервера:
запускает \`node cli service:users addRole\` и стримит его вывод, код
выхода наследуется 1:1.

${DELIVERY}

--id и --role обязательны оба; других флагов у метода нет.

Пример: mpu users -p sl-1 add-role --id 42 --role client`,
    policy: "rw",
    helpWhenBare: true,
    errorName: "users",
    argsSchema: addRoleArgs,
    forms: { selector: { positional: "one" }, print: { short: "p" } },
    resultSchema,
    run: (args, io: WrapIo) =>
      runWrap(
        {
          service: "users",
          method: "addRole",
          clientId: "none",
          flags: () => [
            { name: "id", value: args.id },
            { name: "role", value: args.role },
          ],
        },
        commonArgsOf(args),
        io,
      ),
    render: renderWrap,
    textExitCode: (result) => result.exitCode,
  });
}
