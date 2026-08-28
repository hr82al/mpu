/**
 * Таблица читающих эндпоинтов sl-back: `get-*` и `list-*` (`api.md`).
 * Одна строка — одна команда `mpu api <имя>`; ничего, кроме метода,
 * пути и полей тела, о команде знать не нужно.
 *
 * Методы и пути сняты дословно с машинного слепка дерева рабочей
 * версии (`docs/specs/fixtures/platform/registry/tree.json`, записи
 * группы `api`), а форма вывода — с голденов `fixtures/api/`.
 *
 * Пишущей половины здесь нет намеренно: `create-*`, `delete-*`,
 * `update-*`, `auth-*`, семейства задач (`*-jobs-*`) и `integrity-*`
 * едут следующей поставкой, и до неё группа остаётся на маршруте
 * `legacy` целиком (`platform/registry.md`).
 */

import type { EndpointSpec } from "./endpoint.ts";

export const READ_ENDPOINTS: readonly EndpointSpec[] = [
  { name: "get-client", method: "GET", path: "/admin/client/:userId" },
  {
    name: "get-client-module",
    method: "GET",
    path: "/admin/client/:clientId/modules/:module",
  },
  {
    name: "get-client-spreadsheet",
    method: "GET",
    path: "/admin/client/:clientId/ss/:spreadsheetId",
  },
  {
    name: "get-client-ss-dataset",
    method: "GET",
    path: "/admin/client/:clientId/ss/:spreadsheetId/dataset/:sheetName",
  },
  { name: "get-spreadsheet", method: "GET", path: "/admin/ss/:spreadsheetId" },
  {
    name: "get-ss-values",
    method: "POST",
    path: "/admin/ss/:spreadsheet_id/values",
    fields: [
      { name: "range", type: "string", required: true, help: "A1 range" },
      { name: "majorDimension", type: "string", help: "ROWS|COLUMNS" },
    ],
    body: true,
  },
  { name: "get-user", method: "GET", path: "/admin/user/:userId" },
  {
    name: "get-wb-cabinet-module",
    method: "GET",
    path: "/admin/client/:clientId/wb-cabinets-modules/:sid/:module",
  },
  {
    name: "get-wb-cabinets-by-sid",
    method: "GET",
    path: "/admin/wb-cabinets/by-sid/:sid",
  },
  {
    name: "list-client-modules",
    method: "GET",
    path: "/admin/client/:clientId/modules",
  },
  {
    name: "list-client-ozon-keys",
    method: "GET",
    path: "/admin/client/:clientId/ozon/apikey",
    secrets: true,
  },
  {
    name: "list-client-spreadsheets",
    method: "GET",
    path: "/admin/client/:clientId/ss",
  },
  {
    name: "list-client-ss-datasets",
    method: "GET",
    path: "/admin/client/:clientId/ss/:spreadsheetId/dataset",
  },
  {
    name: "list-client-wb-cabinets",
    method: "GET",
    path: "/admin/client/:clientId/wb-cabinets",
  },
  {
    name: "list-client-wb-tokens",
    method: "GET",
    path: "/admin/client/:clientId/wb/token",
    secrets: true,
  },
  { name: "list-clients", method: "GET", path: "/admin/client" },
  { name: "list-roles", method: "GET", path: "/admin/roles" },
  { name: "list-spreadsheets", method: "GET", path: "/admin/ss" },
  { name: "list-users", method: "GET", path: "/admin/user" },
  {
    name: "list-wb-cabinet-modules",
    method: "GET",
    path: "/admin/client/:clientId/wb-cabinets-modules",
  },
  { name: "list-wb-cabinets", method: "GET", path: "/admin/wb-cabinets" },
];
