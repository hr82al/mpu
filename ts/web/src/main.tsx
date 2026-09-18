/**
 * Точка входа приложения: вход по ключу, затем роутер с экраном
 * «Правила». Токенов страница не видит — cookie `HttpOnly`.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { Rules } from "./Rules.tsx";
import { enter } from "./session.ts";
import "./style.css";

const root = createRootRoute();
const rules = createRoute({
  getParentRoute: () => root,
  path: "/",
  component: Rules,
});
const router = createRouter({ routeTree: root.addChildren([rules]) });

async function main() {
  await enter({
    href: location.href,
    replace: (url) => history.replaceState(null, "", url),
  }, { fetch: (...args) => fetch(...args), base: location.origin });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const element = document.getElementById("root");
  if (element === null) return;
  createRoot(element).render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

main().catch((err) => console.error(err));
