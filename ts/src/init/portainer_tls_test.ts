/**
 * Отключённая проверка TLS-сертификата (`PORTAINER_VERIFY_TLS`,
 * `docs/specs/init.md`, шаг 2): единственный путь клиента Portainer в
 * обход `fetch` (`node:https` + `rejectUnauthorized: false`, у Deno нет
 * клиентской опции, гасящей проверку сертификата). Отдельный файл от
 * `portainer_test.ts` — этому сценарию один нужен самоподписанный
 * сертификат, прочим он только шумит.
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  fetchPortainerJson,
  listEndpoints,
  type PortainerAccess,
  PortainerError,
} from "./portainer.ts";

// Тестовый материал, НЕ секрет: самоподписанный сертификат и приватный
// ключ только для "localhost", ни для чего другого не используются.
// Сгенерированы для этого теста командой:
//   openssl req -x509 -newkey rsa:2048 -keyout k.pem -out c.pem -days 36500 \
//     -nodes -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost"
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDITCCAgmgAwIBAgIUBjG+/cP0We2DjGeTop0Gdqx+uT4wDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDgwNTAzNTIzMFoYDzIxMjYw
NzEyMDM1MjMwWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCjmC+zijHNPROHpA7pJML4+GYk7hKyZq4ocuNw29PX
aMsKQCj3AYDsiLvXAeAnRne4AOtItsHW+Y4IKRGTYMu2LETrfSt3nsEcVVtIp5ag
TA12zaERMgQfsaazHw1L+xvGHo/WiFd5LX/Hs1O8PXJ7oJUNTc+VnHuNWbfO0fGn
tVtBrWdFNPOwbz4o+pkJII8c60CYTclxRl8dK9BH+6I9IBiAXsHUkyCgbqJnbcV5
dRmbtCoUx6HslJyurQojeu2BfsjjyymgW/AoTWnqW5/j060tiOe5Kw8QJdISY5ie
RLpfjLJBTLnl/5Y6z22oL6A7dNZPshYqx+6C57yDMM3NAgMBAAGjaTBnMB0GA1Ud
DgQWBBRZlzuWdvHqWIpIo7JerdWgSyPIpDAfBgNVHSMEGDAWgBRZlzuWdvHqWIpI
o7JerdWgSyPIpDAPBgNVHRMBAf8EBTADAQH/MBQGA1UdEQQNMAuCCWxvY2FsaG9z
dDANBgkqhkiG9w0BAQsFAAOCAQEACaBPlW05KyeEGsMXvrlcEfqg5BMK4G/7c4nt
3VK+jwvPx0Y6JmJAe8btdltxGMcZhS7qVSUMzp1SASTHjVqilqwEkmk48v36c2YR
k2FmH4xEGhJBP0FPjnfnG8TI0lzVFz9wuKlOQcmtUQPXEwZZLJswo32SsqtbqOyS
hi5bKylYMH5UI7nLSBxI0UrY2g4FyNDZQMvWzwADEjUOYDMyQdFcRP1MjB7S9uaa
OQzRq21UzRYsG4LudtssbMO1FTSR8B9oY+ss1AdJ5a0w7v5Was6lbWlAm+3VRZNB
SZGyfkAXFdyHz4627r+uoAeoh4DSRAALYHebujG6oH8M4DQQMg==
-----END CERTIFICATE-----
`;

const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCjmC+zijHNPROH
pA7pJML4+GYk7hKyZq4ocuNw29PXaMsKQCj3AYDsiLvXAeAnRne4AOtItsHW+Y4I
KRGTYMu2LETrfSt3nsEcVVtIp5agTA12zaERMgQfsaazHw1L+xvGHo/WiFd5LX/H
s1O8PXJ7oJUNTc+VnHuNWbfO0fGntVtBrWdFNPOwbz4o+pkJII8c60CYTclxRl8d
K9BH+6I9IBiAXsHUkyCgbqJnbcV5dRmbtCoUx6HslJyurQojeu2BfsjjyymgW/Ao
TWnqW5/j060tiOe5Kw8QJdISY5ieRLpfjLJBTLnl/5Y6z22oL6A7dNZPshYqx+6C
57yDMM3NAgMBAAECggEAAPdpXLsAb/vK4ukWCiGPTKTnBukoeh5U1roAXE59fLnK
l/JowODPkADUyes3FZ77HmlUT9cojlUQwOfr3yjaEJGdYfNuL3mOyX867VMezC6h
gRCrlsGVYvyL2rtgZZEDs9LCuxvjbGdXkxNHojE4vRXl8NtYp8PHZRPhG/CDPXWN
4kPprqCofVkvglOUOSvOmJI2CKMeaY/yDgJiQi83Vvv8IqFT5V34DOF1jwJjMxsy
HMwRxxlyNKg898d9d8jrpmiU20ERpU/p8VH5QIehXtvIgLYyxsa30vyjqIV3aYeA
/J8ym3tmKhdzcGJrflrkcR1tw7Zwz10N6SWGEWRKUQKBgQDmakwhccsecLz1LWU1
aPdkG7mHT/InyV3syTFTr7Xbuaior6elr0+5eohntkFkdF+EEUhJ9ZTs9jkiIg3I
s2TfyzoUeyqFHBNUgDrGEe7IxLUMiVOImhvZ284BtYoYpuCYDUXhBwks2xVIEG7x
Eu6lSACi6E1alKQFStKYJYCYqQKBgQC1wnc832u9OGrbp3DhF0T7loknsg0ieQ5H
YQXhfrjrvVQXzDiwyjcdaXJyXXSIli4Dv2sqLSfs/K0OUbEOH0V7zpSJUWyVRvjD
ZSAJcx3kIf5R2aJCYBUXpRqqdQL62EJmyLt67jhS3KoJghS/g7JnDfzubxUKnu+a
n0Z7Jq5OhQKBgDBCBxviF2aSuiCnl1DuYRIIdH0Qk2kd1ZwoLzqVzILuiZJ656Pd
6daxASynkV6WuQKSFA/ZbY2LrD+n3jcwy2nLyKhNe4RRcwL5sFWXn+lQuZKcmHA9
xqOEU8sr2HZ9TQDLlt0geh147SYguvumuXDIecmk2b6k7w1ktGLFR/+xAoGAWurR
ViOz8sybtxAEiLNpECf2p2KK62l+WPoRRQBsY48q11SSLuyXsSCj3M0ek4v7rGg9
pLU9uW+S6Qy38gZ2bT2iUyXlmK4NlT+qTM/Gbe0LF8ozPdxt8Ivn0MgDG5K9dEiI
by9mARzb+TGWS04HGUGH+YSbE9r4o3F0gfmRSzkCgYBAWNJM+OnPgsqZJsD3OxbB
6ncHhlYXlBZ2hAe/eWHlGJN+JThD61yX79gStIQikZnIdnTWCbvFJOau5SIJr441
yzO4b2bkUTXM/Wu11trdjtcdePnl+wfuYeaKfJBmo2W0BYJ8Bw4YmbBrJ9PdYtPJ
RZ+kSWwgsvKk4hMMyhki4w==
-----END PRIVATE KEY-----
`;

const API_KEY = "proba-tls-key-Vn3wq8";

/**
 * HTTPS-сервер на самоподписанном сертификате `localhost`; гасить
 * `await stop()`. Обработчик по умолчанию отдаёт happy-path ответ;
 * параметр — для сценариев таймаута (сервер не отвечает вовсе / тело
 * зависает), которым нужен свой обработчик поверх того же сертификата.
 */
function fakeTlsServer(
  handler: (req: Request) => Response | Promise<Response> = (req) =>
    Response.json([{ Id: 1, Name: req.headers.get("X-API-Key") ?? "" }]),
): {
  readonly baseUrl: string;
  readonly stop: () => Promise<void>;
} {
  const server = Deno.serve(
    {
      port: 0,
      hostname: "127.0.0.1",
      cert: TEST_CERT,
      key: TEST_KEY,
      onListen: () => {},
    },
    handler,
  );
  // Хост в URL — "127.0.0.1", не "localhost": задача `test` даёт
  // `--allow-net=127.0.0.1` буквальной строкой (`deno.jsonc`), а разрешение
  // сети у Deno и node:-совместимости проверяется по имени хоста до всякого
  // DNS-резолва — "localhost" здесь получил бы отказ права раньше, чем
  // дошёл бы до TLS. Сертификат при этом всё равно самоподписанный: для
  // verifyTls: true отказ ожидаем в любом случае.
  return {
    baseUrl: `https://127.0.0.1:${server.addr.port}`,
    stop: () => server.shutdown(),
  };
}

function accessTo(baseUrl: string, verifyTls: boolean): PortainerAccess {
  return { baseUrl, apiKey: API_KEY, verifyTls };
}

Deno.test("verifyTls: false — запрос проходит мимо fetch через node:https", async () => {
  const { baseUrl, stop } = fakeTlsServer();
  try {
    const endpoints = await listEndpoints(accessTo(baseUrl, false));
    // Заголовок X-API-Key дошёл и на этом пути тоже.
    assertEquals(endpoints, [{ id: 1, name: API_KEY }]);
  } finally {
    await stop();
  }
});

Deno.test("verifyTls: true — самоподписанный сертификат отклоняется", async () => {
  const { baseUrl, stop } = fakeTlsServer();
  try {
    await assertRejects(
      () => listEndpoints(accessTo(baseUrl, true)),
      PortainerError,
    );
  } finally {
    await stop();
  }
});

// Ветка node:https включается только при verifyTls: false — «вызова без
// таймаута не существует» обязано выполняться и здесь, но оба теста
// таймаутов выше (portainer_test.ts) идут по ветке fetch. Регресс вроде
// потерянного `signal` в опциях httpsRequest эти два теста не поймали бы.

Deno.test("verifyTls: false — таймаут заголовков (сервер не отвечает вовсе)", async () => {
  const gate = Promise.withResolvers<void>();
  const { baseUrl, stop } = fakeTlsServer(async () => {
    await gate.promise;
    return new Response("[]");
  });
  try {
    const err = await assertRejects(
      () =>
        fetchPortainerJson(accessTo(baseUrl, false), "/api/endpoints", {
          headersTimeoutMs: 50,
          totalTimeoutMs: 500,
        }),
      PortainerError,
      "no response headers within 50ms",
    );
    assertEquals(err.message, "no response headers within 50ms");
  } finally {
    gate.resolve();
    await stop();
  }
});

Deno.test("verifyTls: false — таймаут тела (заголовки пришли, тело зависло)", async () => {
  const bodyGate = Promise.withResolvers<void>();
  const { baseUrl, stop } = fakeTlsServer(() => {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        await bodyGate.promise;
        controller.enqueue(new TextEncoder().encode("[]"));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  });
  try {
    const err = await assertRejects(
      () =>
        fetchPortainerJson(accessTo(baseUrl, false), "/api/endpoints", {
          headersTimeoutMs: 500,
          totalTimeoutMs: 50,
        }),
      PortainerError,
      "no response within 50ms",
    );
    assertEquals(err.message, "no response within 50ms");
  } finally {
    // Затвор снят до остановки сервера: поток тела обязан закрыться сам,
    // иначе висящий ReadableStream роняет санитайзер ресурсов теста.
    bodyGate.resolve();
    await stop();
  }
});
