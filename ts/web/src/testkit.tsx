/**
 * Для тестов фронта: поддельный `back` (ответы по пути и методу), журнал
 * запросов и рендер экрана с его окружением.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import type { NodeRuling, SnapshotNode, Transport } from "./api.ts";
import { TransportContext } from "./transport.tsx";
import rulings from "./testdata/policy-tree.json" with { type: "json" };
import snapshot from "./testdata/snapshot.json" with { type: "json" };

export const POLICY_TREE = rulings as NodeRuling[];
export const SNAPSHOT = snapshot.nodes as SnapshotNode[];

/** Запрос, который видел поддельный `back`. */
export interface Seen {
  readonly path: string;
  readonly body: Record<string, unknown>;
  readonly accept: string | null;
}

/** Ответ поддельного `back` на запрос; `undefined` — сеть недоступна. */
export type Answer = (seen: Seen) => Response | undefined;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Ответы по умолчанию: оба метода `/rpc` из эталонов. */
export function rpcAnswer(tree: readonly NodeRuling[] = POLICY_TREE): Answer {
  return (seen) => {
    if (seen.path !== "/rpc") return json({}, 404);
    const method = seen.body.method;
    if (method === "policy.tree") return json({ result: tree });
    if (method === "tree.snapshot") {
      return json({ result: { nodes: SNAPSHOT } });
    }
    return json({}, 404);
  };
}

/** Поддельный `back`: журнал запросов и транспорт. */
export function fakeBack(answer: Answer) {
  const seen: Seen[] = [];
  const transport: Transport = {
    base: "http://mpu.localhost:7338",
    fetch: async (input, init) => {
      const text = typeof init?.body === "string" ? init.body : "{}";
      const headers = new Headers(init?.headers);
      const one = {
        path: String(input),
        body: JSON.parse(text),
        accept: headers.get("Accept"),
      };
      seen.push(one);
      const response = answer(one);
      if (response === undefined) throw new TypeError("connection refused");
      return await Promise.resolve(response);
    },
  };
  return { seen, transport };
}

/** Экран в окружении теста. */
export function renderWith(transport: Transport, node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <TransportContext.Provider value={transport}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </TransportContext.Provider>,
  );
}
