/**
 * Финал (`mp-init.md`, «Финал — сквозная проверка ответом», M4-5…M4-8):
 * стенд проверяется ответом по адресам, а не живостью контейнеров —
 * контейнер бывает запущен и при этом не отвечает.
 *
 * Проверка ничего не решает за прогон: не 200 — предупреждение, код
 * выхода не меняется.
 */

import { z } from "zod";
import type { Docker } from "./docker.ts";

/** Что нужно проверке: пробы и печать. */
export interface AnswersContext {
  readonly docker: Docker;
  readonly cwd: string;
  readonly progress: (line: string) => void;
}

/** Ответ адреса: код и тело. */
interface Reply {
  /** Трёхзначный код; ответа нет — `000`, как у curl. */
  readonly status: string;
  readonly body: string;
}

/** Адрес финальной проверки: сам решает, что сказать о своём ответе. */
export interface Address {
  readonly url: string;
  report(reply: Reply, progress: (line: string) => void): void;
}

/** Адрес, от которого ждут ровно 200. */
export class Page implements Address {
  constructor(readonly url: string) {}

  report(reply: Reply, progress: (line: string) => void): void {
    progress(
      reply.status === "200"
        ? `проверка: 200 ${this.url}`
        : `warning: проверка: ${reply.status} ${this.url}`,
    );
  }
}

const healthSchema = z.object({
  checks: z.object({ database: z.object({ status: z.string() }) }),
});

/**
 * Здоровье sl-0: сразу после старта отвечает 503 из-за эвристики
 * памяти при живой базе — отказом считается только база не `ok`.
 */
export class Health implements Address {
  readonly url = "http://localhost:5000/api/health";

  report(reply: Reply, progress: (line: string) => void): void {
    if (reply.status === "200") {
      progress(`проверка: 200 ${this.url}`);
      return;
    }
    progress(
      databaseOk(reply.body)
        ? `проверка: sl-0 — ${reply.status} при database: ok ` +
            "(память на старте), не отказ"
        : `warning: проверка: ${reply.status} ${this.url}`,
    );
  }
}

/** `checks.database.status` тела — `ok`; не JSON или нет поля — нет. */
function databaseOk(body: string): boolean {
  try {
    const parsed = healthSchema.safeParse(JSON.parse(body));
    return parsed.success && parsed.data.checks.database.status === "ok";
  } catch {
    // Не JSON — о базе ответ ничего не говорит; это отказ проверки.
    return false;
  }
}

/** Адреса по порядку: каждый — curl по переадресациям, отчёт — адресу. */
export async function checkAnswers(
  context: AnswersContext,
  addresses: readonly Address[],
): Promise<void> {
  for (const address of addresses) {
    address.report(await replyOf(context, address.url), context.progress);
  }
}

/**
 * `curl -L`: `/ozon/app/` отвечает 308, и без переадресаций проверка
 * врала бы. Код — последней строкой (`-w`), тело — до неё.
 */
async function replyOf(context: AnswersContext, url: string): Promise<Reply> {
  const probe = await context.docker.probe(
    ["curl", "-sS", "-L", "--max-time", "10", "-w", "\\n%{http_code}", url],
    context.cwd,
  );
  const cut = probe.stdout.lastIndexOf("\n");
  const status = probe.stdout.slice(cut + 1);
  return {
    status: /^\d{3}$/.test(status) ? status : "000",
    body: probe.stdout.slice(0, Math.max(cut, 0)),
  };
}
