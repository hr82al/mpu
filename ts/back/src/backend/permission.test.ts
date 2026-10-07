/**
 * Строка хука `PermissionRequest` в ядре (`claude-hook-permission-request.md`,
 * «Ожидание» [D.8], «Срок»): ожидание владельца не занимает места в
 * пределе строк; обрыв строки и остановка сервера — исход «истёк».
 */

import { readFile } from "node:fs/promises";
import { assert, expect, it } from "vitest";
import { PERMISSION_REQUEST } from "../frames/mod.ts";
import { FakeBot, fakeQuestions } from "../botquestions/testbot.ts";
import { Windows } from "../claudehook/mod.ts";
import { Client, type TestBack, withBack, within } from "./testback.ts";

/** Payload права из живого голдена; транскрипта нет. */
async function bashPayload(): Promise<string> {
  const live = JSON.parse(
    await readFile(
      new URL(
        "../claudehook/testdata/permission-request/live-permission-bash.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  return JSON.stringify({ ...live, transcript_path: "/нет/транскрипта" });
}

/** Строка хука: payload приходит полем `stdin` первого кадра. */
async function hookLine(back: TestBack, stdin: string): Promise<Client> {
  const client = new Client(back, "/line");
  await client.opened();
  client.send({
    words: PERMISSION_REQUEST.words,
    cwd: process.cwd(),
    human: false,
    stdin,
  });
  return client;
}

/** Ворота: чтение файла стоит, пока тест не отпустит. */
function gate() {
  const open = Promise.withResolvers<void>();
  let reads = 0;
  const waiting: { count: number; resolve: () => void }[] = [];
  return {
    /** Ждёт, пока чтений станет `count`. */
    entered: (count: number) => {
      const reached = Promise.withResolvers<void>();
      waiting.push({ count, resolve: reached.resolve });
      if (reads >= count) reached.resolve();
      return reached.promise;
    },
    release: () => open.resolve(),
    io: {
      readFile: async () => {
        reads++;
        for (const one of waiting) if (reads >= one.count) one.resolve();
        await open.promise;
        return new Uint8Array();
      },
    },
  };
}

const LAST_EXPIRED = "\n⌛ истёк — ответьте в терминале";

it("15 (D.8): три ждущих вопроса — шестнадцать строк идут без ожидания места", async () => {
  const bot = new FakeBot();
  const held = gate();
  await withBack(
    async (back) => {
      const stdin = await bashPayload();
      const hooks = [];
      for (let index = 0; index < 3; index++) {
        hooks.push(await hookLine(back, stdin));
      }
      // Голова ряда показана, двое ждут за ней: все три строки в ядре.
      await within(bot.called(3), 5000, "три вопроса в ряду");
      expect(bot.calls[2].text.endsWith("\nещё ждут: 2")).toBe(true);
      const lines = [];
      for (let index = 0; index < 16; index++) {
        const client = new Client(back, "/line");
        await client.opened();
        client.start(["xlsx", "ls", "file:", `/${index}.xlsx`]);
        lines.push(client);
      }
      await within(held.entered(16), 5000, "шестнадцать строк исполняются");
      held.release();
      for (const line of lines) await line.finished();
      for (const hook of hooks) hook.close();
    },
    { questions: fakeQuestions(bot), io: held.io },
  );
});

it("11: обрыв строки клиентом — сообщение «истёк»", async () => {
  const bot = new FakeBot();
  await withBack(
    async (back) => {
      const hook = await hookLine(back, await bashPayload());
      await within(bot.called(1), 5000, "вопрос показан");
      hook.close();
      await within(bot.called(2), 5000, "правка в «истёк»");
      assert(bot.calls[1].text.endsWith(LAST_EXPIRED), bot.calls[1].text);
      // Содержимое stdin не попадает в журнал вызовов: исполнения у строки
      // нет, записи — тоже.
      expect(back.called).toStrictEqual([]);
      expect(
        back.logged.filter((text) => text.includes("touch /tmp/x1.txt")),
      ).toStrictEqual([]);
    },
    { questions: fakeQuestions(bot) },
  );
});

it("остановка сервера с ждущим вопросом — не ждёт срока, сообщение «истёк»", async () => {
  const bot = new FakeBot();
  await withBack(
    async (back) => {
      await hookLine(back, await bashPayload());
      await within(bot.called(1), 5000, "вопрос показан");
    },
    { questions: fakeQuestions(bot) },
  );
  expect(bot.calls.length).toBe(2);
  assert(bot.calls[1].text.endsWith(LAST_EXPIRED), bot.calls[1].text);
});

it("D.4: служба под tmux, клиент вне — окна в заголовке нет", async () => {
  const bot = new FakeBot();
  const service: Readonly<Record<string, string>> = {
    TMUX: "/tmp/tmux-1000/default,1,0",
    TMUX_PANE: "%1",
  };
  await withBack(
    async (back) => {
      const hook = await hookLine(back, await bashPayload());
      await within(bot.called(1), 5000, "вопрос показан");
      expect(bot.calls[0].text.split("\n")[0]).toBe("🔐 Bash — ozon");
      hook.close();
    },
    {
      questions: fakeQuestions(bot),
      io: { env: (name) => service[name] },
      windows: new Windows(() => Promise.resolve("w:9 служба\n")),
    },
  );
});
