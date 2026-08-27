/**
 * Переносы клиента (`move-client.md`, `move-client-back.md`): сборка
 * задачи, проброс кода, журнал ходов и ветки реверса.
 *
 * Живой проверки у этой пары не будет принципиально: успешный перенос
 * — это перемещение клиента между боевыми серверами, а застрявший —
 * застрявшая боевая задача. Поэтому здесь закрепляется всё, чем
 * команда управляет: argv, код дочернего процесса и запись хода.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { type CacheDb, UsageError } from "../command/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import {
  type MoveIo,
  renderMoveClient,
  runMoveClient,
} from "./cmd_move_client.ts";
import {
  renderMoveClientBack,
  runMoveClientBack,
} from "./cmd_move_client_back.ts";
import { forgetMove, moveOf, recordMove } from "./journal.ts";
import { transferCommand } from "./transfer.ts";

const CLIENT = 1234;

const ENV: Record<string, string> = {
  PORTAINER_API_KEY: "ключ",
  sl_3: "sl-3.example.test",
};

/**
 * Что «увидел» транспорт: shell-строка команды и путь exec'а.
 *
 * Транспорт заворачивает команду в `sh -c`, поэтому сверяется её
 * текст — тот самый, что уйдёт в контейнер.
 */
interface Ran {
  readonly command: string;
  readonly container: string;
}

/**
 * io со стендовым кэшем: клиент 1234 на sl-3, контейнер `mp-dt-cli`
 * известен Portainer-кэшу.
 */
async function withIo(
  body: (io: MoveIo, db: CacheDb, ran: Ran[]) => Promise<void>,
  options: { withContainer?: boolean } = {},
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    db.execute(
      "INSERT INTO sl_clients (client_id, server, is_active, is_locked," +
        " is_deleted, synced_at) VALUES (?, 'sl-3', 1, 0, 0, 0)",
      CLIENT,
    );
    if (options.withContainer !== false) {
      db.execute(
        "INSERT INTO portainer_containers (portainer_url, endpoint_id," +
          " endpoint_name, container_id, container_name, server_number," +
          " discovered_at) VALUES ('https://portainer.example.test', 1," +
          " 'ферма', 'c1', 'mp-dt-cli', NULL, 0)",
      );
    }
    const ran: Ran[] = [];
    const io = makeFakeIo({
      env: (name: string) => (name === "HOME" ? "/дом" : undefined),
      progress: () => {},
      openCacheDb: () => ({ ...db, [Symbol.dispose]: () => {} }),
      openRemoteOutput: () => ({
        out: () => {},
        err: () => {},
        captured: () => "",
      }),
      envFile: {
        get: (name: string) => ENV[name],
        require: (name: string) => ENV[name] ?? "",
        set: () => Promise.reject(new Error("не ожидается")),
        values: () => ({ ...ENV }),
      },
    });
    await body(io as MoveIo, db, ran);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/**
 * Подставной Portainer: запоминает созданный exec и отвечает заданным
 * кодом. Форма та же, что у обёрток `nodecli` — вызов идёт тем же
 * транспортом.
 */
function transportOptions(code: number, ran: Ran[]) {
  return {
    httpCall: (url: URL, options: { body?: string | Uint8Array }) => {
      if (url.pathname.endsWith("/exec")) {
        const raw = typeof options.body === "string" ? options.body : "{}";
        const body = JSON.parse(raw) as { Cmd?: readonly string[] };
        // Транспорт создаёт два exec'а: рабочий и уборочный (он идёт
        // без `Cmd` переноса). Считаем только первый — он и есть
        // задача, направление которой проверяется.
        const shell = (body.Cmd ?? []).join(" ");
        // Транспорт создаёт два exec'а: рабочий и уборочный. Считаем
        // тот, что несёт задачу, — его направление и проверяется.
        if (shell.includes("createJob")) {
          ran.push({ command: shell, container: url.pathname });
        }
      }
      return Promise.resolve({
        status: 200,
        text: url.pathname.endsWith("/json")
          ? JSON.stringify({ ExitCode: code })
          : '{"Id":"exec-1"}',
        retryAfter: null,
      });
    },
    openChannel: () =>
      Promise.resolve({
        chunks: (async function* () {
          yield new TextEncoder().encode(
            "HTTP/1.1 101 Switching Protocols\r\n\r\n",
          );
          yield Uint8Array.of(0x88, 0x00);
        })(),
        write: () => {},
        close: () => {},
      }),
    runProcess: () => {
      throw new Error("ssh не должен участвовать: Portainer настроен");
    },
  };
}

Deno.test("команда постановки: source, target, client-id и --destroy", () => {
  const command = transferCommand({
    clientId: CLIENT,
    sourceServer: 3,
    targetServer: 4,
  });
  assertEquals(
    command.join(" "),
    [
      "node cli service:clientsTransfer createJob",
      "--source sl-3",
      "--target sl-4",
      "--client-id 1234",
      // Без `--destroy` перенос стал бы копией, и клиент остался бы на
      // обоих серверах — тихое удвоение вместо переезда.
      "--destroy",
    ].join(" "),
  );
});

Deno.test("ход записывается только после успешной постановки", async (t) => {
  await t.step("код 0 — запись появилась", async () => {
    await withIo(async (io, db, ran) => {
      const result = await runMoveClient(
        { selector: String(CLIENT), target: "sl-4" },
        io,
        transportOptions(0, ran),
      );
      assertEquals([result.exitCode, result.recorded], [0, true]);
      const move = moveOf(db, CLIENT);
      assertEquals([move?.source, move?.target], ["sl-3", "sl-4"]);
      // Направление сверяется по argv, дошедшему до транспорта, а не
      // по результату: перевёрнутый вызов увёл бы клиента не туда — и
      // с `--destroy`, — а журнал при этом писал бы правду.
      assertEquals(ran.length, 1);
      assertStringIncludes(
        ran[0].command,
        "node cli service:clientsTransfer createJob --source sl-3 " +
          "--target sl-4 --client-id 1234 --destroy",
      );
      assertStringIncludes(ran[0].container, "/exec");
    });
  });

  await t.step("ненулевой код — записи нет", async () => {
    await withIo(async (io, db, ran) => {
      const result = await runMoveClient(
        { selector: String(CLIENT), target: "sl-4" },
        io,
        transportOptions(7, ran),
      );
      // Иначе реверс повёл бы клиента оттуда, где его нет: задача не
      // поставлена, переезда не случилось.
      assertEquals([result.exitCode, result.recorded], [7, false]);
      assertEquals(moveOf(db, CLIENT), undefined);
    });
  });
});

Deno.test("код постановки доносится 1:1", async () => {
  for (const code of [0, 2, 17]) {
    await withIo(async (io, _db, ran) => {
      const result = await runMoveClient(
        { selector: String(CLIENT), target: "sl-4" },
        io,
        transportOptions(code, ran),
      );
      assertEquals(result.exitCode, code);
      assertEquals(renderMoveClient(), "");
    });
  }
});

Deno.test("отказы ввода: --target и совпадение серверов", async (t) => {
  await t.step("--target не вида sl-N", async () => {
    await withIo(async (io, _db, ran) => {
      await assertRejects(
        () =>
          runMoveClient(
            { selector: String(CLIENT), target: "четвёртый" },
            io,
            transportOptions(0, ran),
          ),
        UsageError,
        "bad --target 'четвёртый' (expected sl-N)",
      );
      assertEquals(ran.length, 0, "задача не ставилась");
    });
  });

  await t.step("source == target", async () => {
    await withIo(async (io, _db, ran) => {
      await assertRejects(
        () =>
          runMoveClient(
            { selector: String(CLIENT), target: "sl-3" },
            io,
            transportOptions(0, ran),
          ),
        UsageError,
        "source и target оба sl-3 — нечего переносить",
      );
      assertEquals(ran.length, 0);
    });
  });
});

Deno.test("реверс без записи хода — громкий отказ", async () => {
  await withIo(async (io, _db, ran) => {
    await assertRejects(
      () =>
        runMoveClientBack(
          { selector: String(CLIENT), target: undefined },
          io,
          transportOptions(0, ran),
        ),
      UsageError,
      "нет записанного хода для client 1234 (сначала `mpu move-client`, " +
        "либо запусти `mpu init`)",
    );
    // Угадывать направление нельзя: задача не ставилась.
    assertEquals(ran.length, 0);
  });
});

Deno.test("реверс: направление обратное записи, запись снимается", async () => {
  await withIo(async (io, db, ran) => {
    recordMove(db, {
      clientId: CLIENT,
      source: "sl-3",
      target: "sl-4",
      movedAt: 1000,
    });
    const result = await runMoveClientBack(
      { selector: String(CLIENT), target: undefined },
      io,
      transportOptions(0, ran),
    );
    assertEquals([result.action, result.exitCode], ["revert", 0]);
    assertEquals(result.removed, true);
    assertEquals(moveOf(db, CLIENT), undefined);
    // Обратное направление проверяется по argv: свап здесь означал бы
    // повторный увод клиента с домашнего сервера вместо возврата.
    assertEquals(ran.length, 1);
    assertStringIncludes(
      ran[0].command,
      "node cli service:clientsTransfer createJob --source sl-4 " +
        "--target sl-3 --client-id 1234 --destroy",
    );
  });
});

Deno.test("неуспешный реверс запись не снимает", async () => {
  await withIo(async (io, db, ran) => {
    recordMove(db, {
      clientId: CLIENT,
      source: "sl-3",
      target: "sl-4",
      movedAt: 1000,
    });
    const result = await runMoveClientBack(
      { selector: String(CLIENT), target: undefined },
      io,
      transportOptions(5, ran),
    );
    assertEquals([result.exitCode, result.removed], [5, false]);
    // Иначе повторный возврат потерял бы направление, а клиент остался
    // бы на чужом сервере.
    assertEquals(moveOf(db, CLIENT)?.target, "sl-4");
  });
});

Deno.test("повреждённая запись и совпавшие серверы — отказ", async (t) => {
  await t.step("номер сервера не разбирается", async () => {
    await withIo(async (io, db, ran) => {
      recordMove(db, {
        clientId: CLIENT,
        source: "непонятно",
        target: "sl-4",
        movedAt: 1000,
      });
      await assertRejects(
        () =>
          runMoveClientBack(
            { selector: String(CLIENT), target: undefined },
            io,
            transportOptions(0, ran),
          ),
        UsageError,
        "повреждённая запись хода: непонятно → sl-4",
      );
      assertEquals(ran.length, 0);
    });
  });

  await t.step("source и target записи совпали", async () => {
    await withIo(async (io, db, ran) => {
      recordMove(db, {
        clientId: CLIENT,
        source: "sl-4",
        target: "sl-4",
        movedAt: 1000,
      });
      await assertRejects(
        () =>
          runMoveClientBack(
            { selector: String(CLIENT), target: undefined },
            io,
            transportOptions(0, ran),
          ),
        UsageError,
        "source и target записи оба sl-4 — нечего возвращать",
      );
    });
  });
});

Deno.test("rm: идемпотентен и переноса не запускает", async (t) => {
  await t.step("записи нет — сообщение и код 0", async () => {
    await withIo(async (io, _db, ran) => {
      const lines: string[] = [];
      const loud = { ...io, progress: (line: string) => void lines.push(line) };
      const result = await runMoveClientBack(
        { selector: "rm", target: String(CLIENT) },
        loud,
        transportOptions(0, ran),
      );
      // Удалять нечего — это успех: повторный `rm` обязан быть
      // безобидным, как `mpu config --unset`.
      assertEquals([result.exitCode, result.removed], [0, false]);
      // Префикс команды — часть формата семейства: голая строка в
      // stderr выглядит чужой среди сообщений `mpu <команда>: …`.
      assertEquals(
        lines,
        ["mpu move-client-back: нет записи хода для client 1234"],
      );
      assertEquals(ran.length, 0);
    });
  });

  await t.step("запись есть — удаляется и печатается", async () => {
    await withIo(async (io, db, ran) => {
      recordMove(db, {
        clientId: CLIENT,
        source: "sl-3",
        target: "sl-4",
        movedAt: 1000,
      });
      const result = await runMoveClientBack(
        { selector: "rm", target: String(CLIENT) },
        io,
        transportOptions(0, ran),
      );
      assertEquals(result.removed, true);
      assertEquals(moveOf(db, CLIENT), undefined);
      assertStringIncludes(
        renderMoveClientBack(result),
        "запись удалена: client 1234, sl-3 → sl-4",
      );
      assertEquals(ran.length, 0, "перенос не запускался");
    });
  });

  await t.step("rm без селектора — ошибка ввода", async () => {
    await withIo(async (io, _db, ran) => {
      await assertRejects(
        () =>
          runMoveClientBack(
            { selector: "rm", target: undefined },
            io,
            transportOptions(0, ran),
          ),
        UsageError,
        "`rm` требует селектор (rm <selector>)",
      );
    });
  });
});

Deno.test("ls: журнал новыми сверху; пустой — своя строка", async (t) => {
  await t.step("пусто", async () => {
    await withIo(async (io, _db, ran) => {
      const result = await runMoveClientBack(
        { selector: undefined, target: undefined },
        io,
        transportOptions(0, ran),
      );
      assertEquals(result.action, "ls");
      assertEquals(renderMoveClientBack(result), "нет записанных ходов\n");
      assertEquals(ran.length, 0);
    });
  });

  await t.step("две записи: новая первой", async () => {
    await withIo(async (io, db, ran) => {
      recordMove(db, {
        clientId: 1,
        source: "sl-1",
        target: "sl-2",
        movedAt: 1000,
      });
      recordMove(db, {
        clientId: 2,
        source: "sl-2",
        target: "sl-3",
        movedAt: 2000,
      });
      const result = await runMoveClientBack(
        { selector: "ls", target: undefined },
        io,
        transportOptions(0, ran),
      );
      assertEquals(result.moves.map((move) => move.client_id), [2, 1]);
      assertStringIncludes(renderMoveClientBack(result), "sl-2 → sl-3");
    });
  });
});

Deno.test("журнал без таблицы равнозначен пустому", async () => {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    // Ни одного `bootstrap`: кэш-БД без `mpu init`.
    assertEquals(moveOf(db, CLIENT), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("контейнер переносов не в кэше — отказ с подсказкой", async () => {
  await withIo(async (io, _db, ran) => {
    const err = await assertRejects(
      () =>
        runMoveClient(
          { selector: String(CLIENT), target: "sl-4" },
          io,
          transportOptions(0, ran),
        ),
      UsageError,
      "контейнер mp-dt-cli не найден в кэше Portainer",
    );
    // Общий резолв селектора, не найдя имени, пошёл бы искать клиента —
    // и заголовок, содержащий `mp-dt-cli`, увёл бы задачу в чужой
    // контейнер. Здесь имя константное, и «не нашли» значит одно.
    assertStringIncludes(String(err.hint), "mpu init");
    assertEquals(ran.length, 0);
  }, { withContainer: false });
});

Deno.test("журнал без таблицы: запись предупреждает, rm молчит", async (t) => {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    // Ни одного `bootstrap`: кэш-БД без `mpu init`.
    await t.step("recordMove не заводит схему сам", () => {
      let failed = false;
      try {
        recordMove(db, {
          clientId: CLIENT,
          source: "sl-3",
          target: "sl-4",
          movedAt: 1000,
        });
      } catch {
        failed = true;
      }
      // Тихо создав схему, команда сделала бы недостижимым
      // предупреждение «реверс работать не будет» (отклонение спеки).
      assertEquals(failed, true);
      assertEquals(
        db.query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          "client_moves",
        ),
        [],
      );
    });

    await t.step("forgetMove отвечает «записи не было»", () => {
      assertEquals(forgetMove(db, CLIENT), false);
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
