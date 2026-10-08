/**
 * Для тестов строк с `logs`: Loki на петле с заданным ответом и кэш-БД во
 * временном каталоге — io, которой хватает команде без сети наружу.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandIo } from "@mpu/command";
import { writeLokiCache } from "../loki/mod.ts";
import { openCacheDb } from "@mpu/command/store";
import { serveFetch } from "@mpu/testing";

/** Ответ `query_range`: потоки с метками и парами `[ts, строка]`. */
export function lokiBody(
  streams: readonly {
    readonly labels: Readonly<Record<string, string>>;
    readonly values: readonly (readonly [string, string])[];
  }[],
): string {
  return JSON.stringify({
    data: {
      result: streams.map((one) => ({
        stream: one.labels,
        values: one.values,
      })),
    },
  });
}

/**
 * Loki, отвечающий `body` на любой запрос, и кэш с хостами `hosts` на
 * время `fn`; `asked` — сколько раз его спросили.
 */
export async function withFakeLoki(
  body: string,
  fn: (io: Partial<CommandIo>, asked: () => number) => Promise<void>,
  hosts: readonly string[] = ["sl-1"],
): Promise<void> {
  let asked = 0;
  const server = await serveFetch(() => {
    asked++;
    return new Response(body);
  });
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  const values: Readonly<Record<string, string>> = {
    LOKI_URL: server.baseUrl,
  };
  try {
    {
      using db = openCacheDb(`${dir}/cache.db`);
      db.bootstrap();
      writeLokiCache(db, { hosts: [...hosts], pairs: [] }, 0);
    }
    await fn(
      {
        envFile: {
          get: (name) => values[name],
          values: () => values,
          require: (name) => values[name] ?? "",
          set: () => Promise.resolve(),
        },
        openCacheDb: () => openCacheDb(`${dir}/cache.db`),
      },
      () => asked,
    );
  } finally {
    await server.stop();
    await rm(dir, { recursive: true });
  }
}
