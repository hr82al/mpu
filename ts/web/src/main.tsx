/**
 * Точка входа приложения: вход по ключу, затем роутер с экранами
 * «Правила» и «Образ». Токенов страница не видит — cookie `HttpOnly`.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { Image } from "./Image.tsx";
import { Rules } from "./Rules.tsx";
import { enter } from "./session.ts";
import "./style.css";

/** Навигация между экранами — у корня: экраны о ней не знают. */
function Layout() {
  return (
    <>
      <nav>
        <Link to="/">Правила</Link> <Link to="/image">Образ</Link>
      </nav>
      <Outlet />
    </>
  );
}

const root = createRootRoute({ component: Layout });
const rules = createRoute({
  getParentRoute: () => root,
  path: "/",
  component: Rules,
});
const image = createRoute({
  getParentRoute: () => root,
  path: "/image",
  component: Image,
});
const router = createRouter({
  routeTree: root.addChildren([rules, image]),
});

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
