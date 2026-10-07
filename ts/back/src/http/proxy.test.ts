/**
 * Наблюдаемый след «Прокси окружения» (`docs/specs/platform/loki-http.md`):
 * при прокси окружения, указывающем на ловушку, вызов к адресу стенда
 * получает ответ сервера, а явный прокси и доменное имя приходят ловушке.
 *
 * Вызовы делает подпроцесс с окружением, выставленным тестом целиком:
 * клиент `fetch` читает прокси из окружения процесса, и унаследованный
 * `NO_PROXY` с `127.0.0.1` сделал бы тест зелёным по совпадению.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { type FakeHttp, serveFetch } from "../testing/http.ts";

/** Сервер на петле, отвечающий телом `body` и помнящий число запросов. */
async function listen(body: string): Promise<{
  readonly server: FakeHttp;
  readonly requests: () => number;
}> {
  let count = 0;
  const server = await serveFetch(async (request) => {
    count++;
    await request.body?.cancel();
    return new Response(body);
  });
  return { server, requests: () => count };
}

/** Окружение подпроцесса: прокси — ловушка, `NO_PROXY` пуст. */
function proxyEnv(trap: string): Record<string, string> {
  const env: Record<string, string> = { NO_COLOR: "1", NO_PROXY: "" };
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
    env[name] = trap;
    env[name.toLowerCase()] = trap;
  }
  env.no_proxy = "";
  // Кэш модулей и путь к `deno` — не окружение прокси, без них
  // подпроцесс не запустится или полезет за зависимостями в чужой кэш.
  for (const name of ["PATH", "HOME", "DENO_DIR", "TMPDIR"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * Код подпроцесса: четыре вызова транспорта, тела ответов — JSON в stdout.
 * `domain` — тот же сервер по имени `localhost`: имя адресом стенда не
 * считается, и мимо прокси такой вызов получил бы ответ сервера, а не
 * ловушки. Имя `.invalid` не годится — до прокси запрос с ним не доходит.
 */
function probe(target: string, domain: string, trap: string): string {
  const mod = new URL("./mod.ts", import.meta.url).href;
  return `
    import { httpGet, httpSend } from ${JSON.stringify(mod)};
    const timeouts = { headersTimeoutMs: 2000, totalTimeoutMs: 5000 };
    const target = new URL(${JSON.stringify(target)});
    const domain = new URL(${JSON.stringify(domain)});
    const bodies = {
      get: (await httpGet(target, { timeouts })).text,
      send: (await httpSend(target, { timeouts, method: "POST", body: "x" })).text,
      explicit: (await httpSend(target, { timeouts, proxy: ${
    JSON.stringify(trap)
  } })).text,
      domain: (await httpGet(domain, { timeouts })).text,
    };
    console.log(JSON.stringify(bodies));
  `;
}

it("адрес стенда идёт мимо прокси окружения, явный прокси и домен — через него", async () => {
  const target = await listen("target");
  const trap = await listen("trap");
  try {
    const trapUrl = trap.server.baseUrl;
    const port = target.server.port;
    const targetUrl = `http://127.0.0.1:${port}/ready`;
    const domainUrl = `http://localhost:${port}/ready`;
    // Окружение — только `proxyEnv`: `env` у `execFile` заменяет
    // унаследованное целиком. Ненулевой выход — отказ с stderr в тексте.
    const { stdout } = await promisify(execFile)(
      "deno",
      ["eval", probe(targetUrl, domainUrl, trapUrl)],
      { env: proxyEnv(trapUrl) },
    );
    expect(JSON.parse(stdout)).toStrictEqual({
      get: "target",
      send: "target",
      explicit: "trap",
      domain: "trap",
    });
    // Два запроса ловушки — явный прокси и доменное имя; вызовы к адресу
    // стенда её не касаются.
    expect(trap.requests(), "запросов ловушке").toBe(2);
    expect(target.requests(), "запросов серверу").toBe(2);
  } finally {
    await target.server.stop();
    await trap.server.stop();
  }
});
