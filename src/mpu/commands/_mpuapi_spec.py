"""Декларативный каталог sl-back admin endpoints, обёрнутых в `mpuapi-*` команды.

Каждая запись в `COMMANDS` — отдельный bin (см. `[project.scripts]` в `pyproject.toml`).
По имени bin'а (`mpuapi-<name>`) `_mpuapi_runtime` строит typer-app и вызывает
`SlApi.request(method, path, body=..., query=...)`.

Маппинг параметров:
  - `path_params` (с `:colon` в `path`) → позиционные аргументы команды (в порядке появления).
  - `body_fields` → опции `--<key> <value>` (типизированные через `field.type`).
  - Если `accepts_raw_body=True` — добавляется опция `--body / -b '<json>'` или `@file.json`,
    которая полностью перекрывает `body_fields` при использовании.
  - `tokenOnly=True` (только у `mpuapi-get-token`) — на выходе печатается только токен.
  - `noAuth=True` — запрос без `Authorization` (только `/auth/login`).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

HttpMethod = Literal["GET", "POST", "PATCH", "PUT", "DELETE"]
FieldType = Literal["string", "number", "boolean", "json"]


@dataclass(frozen=True)
class PathParam:
    name: str
    description: str


@dataclass(frozen=True)
class BodyField:
    name: str
    type: FieldType
    description: str
    required: bool = False


@dataclass(frozen=True)
class CommandSpec:
    name: str
    method: HttpMethod
    path: str
    summary: str
    path_params: tuple[PathParam, ...] = ()
    body_fields: tuple[BodyField, ...] = ()
    accepts_raw_body: bool = False
    no_auth: bool = False
    token_only: bool = False
    description: str | None = None


# ──────────────────────────────────────────────────────────────────────────────
# Помощники для повторяющихся определений
# ──────────────────────────────────────────────────────────────────────────────

CLIENT_ID = PathParam("clientId", "numeric client_id")
USER_ID = PathParam("userId", "numeric user/client id")
SS_ID = PathParam("spreadsheetId", "spreadsheet_id (Google Sheets)")
SS_ID_SNAKE = PathParam("spreadsheet_id", "spreadsheet_id (Google Sheets)")

JOBS_BODY: tuple[BodyField, ...] = (
    BodyField("client_id", "number", "client_id"),
    BodyField("queue", "string", "BullMQ queue name"),
    BodyField("state", "string", "active|waiting|completed|failed|delayed|paused"),
    BodyField("jobId", "string", "BullMQ job id"),
    BodyField("sid", "string", "(wb only) WB seller sid"),
    BodyField("seller_client_id", "string", "(ozon only) seller client id"),
    BodyField("limit", "number", "page size"),
)


def _jobs_group(prefix: str, segment: str) -> list[CommandSpec]:
    """5 endpoints контроллера jobs-control: queue-status / active-jobs / by-state / job / abort."""
    pairs = (
        ("queue-status", "queue-status"),
        ("active-jobs", "active-jobs"),
        ("by-state", "jobs-by-state"),
        ("job", "job"),
        ("abort", "abort"),
    )
    return [
        CommandSpec(
            name=f"{prefix}-{suffix}",
            method="POST",
            path=f"/admin/jobs/jobsControl/{segment}/{sub}",
            summary=f"POST /admin/jobs/jobsControl/{segment}/{sub}",
            accepts_raw_body=True,
            body_fields=JOBS_BODY,
        )
        for suffix, sub in pairs
    ]


# ──────────────────────────────────────────────────────────────────────────────
# Каталог
# ──────────────────────────────────────────────────────────────────────────────

COMMANDS: tuple[CommandSpec, ...] = (
    # ─── /auth ───────────────────────────────────────────────────────────────
    CommandSpec(
        name="get-token",
        method="POST",
        path="/auth/login",
        summary="POST /auth/login → print accessToken (cached 10 min)",
        no_auth=True,
        token_only=True,
        body_fields=(
            BodyField("email", "string", "login email (default: env TOKEN_EMAIL)"),
            BodyField("password", "string", "password (default: env TOKEN_PASSWORD)"),
        ),
        description=(
            "POST /auth/login. По умолчанию использует TOKEN_EMAIL / TOKEN_PASSWORD из "
            "~/.config/mpu/.env. Кэширует токен в ~/.config/mpu/.api-token.json (TTL 10 мин); "
            "последующие mpuapi-* команды переиспользуют его."
        ),
    ),
    CommandSpec(
        name="auth-login",
        method="POST",
        path="/auth/login",
        summary="POST /auth/login → full response (accessToken + user)",
        no_auth=True,
        body_fields=(
            BodyField("email", "string", "login email", required=True),
            BodyField("password", "string", "password", required=True),
        ),
    ),
    CommandSpec(
        name="auth-logout",
        method="POST",
        path="/auth/logout",
        summary="POST /auth/logout",
    ),
    CommandSpec(
        name="auth-refresh",
        method="GET",
        path="/auth/refresh",
        summary="GET /auth/refresh — refresh accessToken (admin only)",
    ),
    CommandSpec(name="auth-verify", method="GET", path="/auth/verify", summary="GET /auth/verify"),
    CommandSpec(
        name="auth-resend-email",
        method="GET",
        path="/auth/resendEmail",
        summary="GET /auth/resendEmail",
    ),
    CommandSpec(
        name="auth-change-password",
        method="POST",
        path="/auth/change-password",
        summary="POST /auth/change-password",
        body_fields=(
            BodyField("email", "string", "login email", required=True),
            BodyField("password", "string", "old password", required=True),
            BodyField("newPassword", "string", "new password", required=True),
        ),
    ),
    # ─── /admin/user ─────────────────────────────────────────────────────────
    CommandSpec(name="list-users", method="GET", path="/admin/user", summary="GET /admin/user"),
    CommandSpec(
        name="get-user",
        method="GET",
        path="/admin/user/:userId",
        summary="GET /admin/user/:userId",
        path_params=(USER_ID,),
    ),
    CommandSpec(
        name="create-user",
        method="POST",
        path="/admin/user",
        summary="POST /admin/user — create user",
        accepts_raw_body=True,
        body_fields=(
            BodyField("email", "string", "user email", required=True),
            BodyField("password", "string", "password"),
            BodyField("name", "string", "display name"),
            BodyField("roles", "json", "roles array as JSON, e.g. '[\"admin\"]'"),
        ),
    ),
    CommandSpec(
        name="update-user",
        method="PATCH",
        path="/admin/user/:userId",
        summary="PATCH /admin/user/:userId",
        path_params=(USER_ID,),
        accepts_raw_body=True,
        body_fields=(
            BodyField("email", "string", "user email"),
            BodyField("password", "string", "new password"),
            BodyField("name", "string", "display name"),
            BodyField("is_active", "boolean", "is_active flag"),
            BodyField("roles", "json", "roles array as JSON"),
        ),
    ),
    CommandSpec(
        name="delete-user",
        method="DELETE",
        path="/admin/user/:userId",
        summary="DELETE /admin/user/:userId — soft delete",
        path_params=(USER_ID,),
    ),
    # ─── /admin/roles ────────────────────────────────────────────────────────
    CommandSpec(name="list-roles", method="GET", path="/admin/roles", summary="GET /admin/roles"),
    # ─── /admin/client ───────────────────────────────────────────────────────
    CommandSpec(
        name="list-clients", method="GET", path="/admin/client", summary="GET /admin/client"
    ),
    CommandSpec(
        name="get-client",
        method="GET",
        path="/admin/client/:userId",
        summary="GET /admin/client/:userId",
        path_params=(USER_ID,),
    ),
    CommandSpec(
        name="create-client",
        method="POST",
        path="/admin/client",
        summary="POST /admin/client",
        accepts_raw_body=True,
        body_fields=(
            BodyField("id", "number", "optional client_id (BIGSERIAL if omitted)"),
            BodyField("title", "string", "display title"),
            BodyField("is_active", "boolean", "is_active flag"),
        ),
    ),
    CommandSpec(
        name="update-client",
        method="PATCH",
        path="/admin/client/:userId",
        summary="PATCH /admin/client/:userId",
        path_params=(USER_ID,),
        accepts_raw_body=True,
        body_fields=(
            BodyField("is_active", "boolean", "is_active flag"),
            BodyField("is_web", "boolean", "is_web flag"),
            BodyField("title", "string", "display title"),
        ),
    ),
    CommandSpec(
        name="delete-client",
        method="DELETE",
        path="/admin/client/:userId",
        summary="DELETE /admin/client/:userId — soft delete",
        path_params=(USER_ID,),
    ),
    CommandSpec(
        name="destroy-client",
        method="DELETE",
        path="/admin/client/:userId/destroy",
        summary="DELETE /admin/client/:userId/destroy — HARD destroy (irreversible)",
        path_params=(USER_ID,),
    ),
    # ─── /admin/client/:clientId/datasets ────────────────────────────────────
    CommandSpec(
        name="dataset-get",
        method="POST",
        path="/admin/client/:clientId/datasets/data/get",
        summary="POST /admin/client/:clientId/datasets/data/get",
        path_params=(CLIENT_ID,),
        accepts_raw_body=True,
        body_fields=(
            BodyField("name", "string", "dataset name", required=True),
            BodyField("params", "json", "dataset params as JSON"),
        ),
    ),
    CommandSpec(
        name="dataset-save",
        method="POST",
        path="/admin/client/:clientId/datasets/data/save",
        summary="POST /admin/client/:clientId/datasets/data/save",
        path_params=(CLIENT_ID,),
        accepts_raw_body=True,
        body_fields=(
            BodyField("name", "string", "dataset name", required=True),
            BodyField("params", "json", "dataset params as JSON"),
            BodyField("data", "json", "rows as JSON"),
        ),
    ),
    CommandSpec(
        name="dataset-wb-unit-source",
        method="POST",
        path="/admin/client/:clientId/datasets/data/wb_unit_source",
        summary="POST /admin/client/:clientId/datasets/data/wb_unit_source",
        path_params=(CLIENT_ID,),
        accepts_raw_body=True,
    ),
    # ─── /admin/client/:clientId/modules ─────────────────────────────────────
    CommandSpec(
        name="list-client-modules",
        method="GET",
        path="/admin/client/:clientId/modules",
        summary="GET /admin/client/:clientId/modules",
        path_params=(CLIENT_ID,),
    ),
    CommandSpec(
        name="add-client-module",
        method="POST",
        path="/admin/client/:clientId/modules",
        summary="POST /admin/client/:clientId/modules",
        path_params=(CLIENT_ID,),
        body_fields=(BodyField("module_name", "string", "module name", required=True),),
    ),
    CommandSpec(
        name="remove-client-module",
        method="DELETE",
        path="/admin/client/:clientId/modules/:module_name",
        summary="DELETE /admin/client/:clientId/modules/:module_name",
        path_params=(CLIENT_ID, PathParam("module_name", "module name")),
    ),
    # ─── /admin/wb-cabinets ──────────────────────────────────────────────────
    CommandSpec(
        name="list-wb-cabinets",
        method="GET",
        path="/admin/wb-cabinets",
        summary="GET /admin/wb-cabinets",
    ),
    CommandSpec(
        name="get-wb-cabinets-by-sid",
        method="GET",
        path="/admin/wb-cabinets/by-sid/:sid",
        summary="GET /admin/wb-cabinets/by-sid/:sid",
        path_params=(PathParam("sid", "WB seller sid"),),
    ),
    CommandSpec(
        name="list-client-wb-cabinets",
        method="GET",
        path="/admin/client/:clientId/wb-cabinets",
        summary="GET /admin/client/:clientId/wb-cabinets",
        path_params=(CLIENT_ID,),
    ),
    # ─── /admin/client/:clientId/wb-cabinets-modules ─────────────────────────
    CommandSpec(
        name="list-wb-cabinet-modules",
        method="GET",
        path="/admin/client/:clientId/wb-cabinets-modules",
        summary="GET /admin/client/:clientId/wb-cabinets-modules",
        path_params=(CLIENT_ID,),
    ),
    CommandSpec(
        name="add-wb-cabinet-module",
        method="POST",
        path="/admin/client/:clientId/wb-cabinets-modules",
        summary="POST /admin/client/:clientId/wb-cabinets-modules",
        path_params=(CLIENT_ID,),
        body_fields=(
            BodyField("sid", "string", "WB seller sid", required=True),
            BodyField("module_name", "string", "module name", required=True),
        ),
    ),
    CommandSpec(
        name="remove-wb-cabinet-module",
        method="DELETE",
        path="/admin/client/:clientId/wb-cabinets-modules/:sid/:module_name",
        summary="DELETE /admin/client/:clientId/wb-cabinets-modules/:sid/:module_name",
        path_params=(
            CLIENT_ID,
            PathParam("sid", "WB seller sid"),
            PathParam("module_name", "module name"),
        ),
    ),
    # ─── /admin/ss ───────────────────────────────────────────────────────────
    CommandSpec(name="list-spreadsheets", method="GET", path="/admin/ss", summary="GET /admin/ss"),
    CommandSpec(
        name="get-spreadsheet",
        method="GET",
        path="/admin/ss/:spreadsheetId",
        summary="GET /admin/ss/:spreadsheetId",
        path_params=(SS_ID,),
    ),
    CommandSpec(
        name="create-spreadsheet",
        method="POST",
        path="/admin/ss",
        summary="POST /admin/ss",
        accepts_raw_body=True,
        body_fields=(
            BodyField("client_id", "number", "client_id", required=True),
            BodyField("spreadsheet_id", "string", "spreadsheet_id", required=True),
            BodyField("is_active", "boolean", "is_active flag"),
            BodyField("script_id", "string", "Apps Script id"),
            BodyField("title", "string", "display title"),
            BodyField("template_name", "string", "template name"),
            BodyField("subscriptionExpiresAt", "string", "ISO date"),
        ),
    ),
    CommandSpec(
        name="update-spreadsheet",
        method="PATCH",
        path="/admin/ss/:spreadsheetId",
        summary="PATCH /admin/ss/:spreadsheetId",
        path_params=(SS_ID,),
        accepts_raw_body=True,
        body_fields=(
            BodyField("is_active", "boolean", "is_active flag"),
            BodyField("script_id", "string", "Apps Script id"),
            BodyField("title", "string", "display title"),
            BodyField("subscriptionExpiresAt", "string", "ISO date"),
        ),
    ),
    CommandSpec(
        name="delete-spreadsheet",
        method="DELETE",
        path="/admin/ss/:spreadsheetId",
        summary="DELETE /admin/ss/:spreadsheetId",
        path_params=(SS_ID,),
    ),
    # ─── /admin/ss/:spreadsheet_id/values ────────────────────────────────────
    CommandSpec(
        name="get-ss-values",
        method="POST",
        path="/admin/ss/:spreadsheet_id/values",
        summary="POST /admin/ss/:spreadsheet_id/values",
        path_params=(SS_ID_SNAKE,),
        accepts_raw_body=True,
        body_fields=(
            BodyField("range", "string", "A1 range", required=True),
            BodyField("majorDimension", "string", "ROWS|COLUMNS"),
        ),
    ),
    # ─── /admin/ss/:spreadsheetId/my-access ──────────────────────────────────
    CommandSpec(
        name="get-ss-my-access",
        method="GET",
        path="/admin/ss/:spreadsheetId/my-access",
        summary="GET /admin/ss/:spreadsheetId/my-access",
        path_params=(SS_ID,),
    ),
    # ─── /admin/client/:clientId/ss ──────────────────────────────────────────
    CommandSpec(
        name="list-client-spreadsheets",
        method="GET",
        path="/admin/client/:clientId/ss",
        summary="GET /admin/client/:clientId/ss",
        path_params=(CLIENT_ID,),
    ),
    CommandSpec(
        name="get-client-spreadsheet",
        method="GET",
        path="/admin/client/:clientId/ss/:spreadsheetId",
        summary="GET /admin/client/:clientId/ss/:spreadsheetId",
        path_params=(CLIENT_ID, SS_ID),
    ),
    CommandSpec(
        name="create-client-spreadsheet",
        method="POST",
        path="/admin/client/:clientId/ss",
        summary="POST /admin/client/:clientId/ss",
        path_params=(CLIENT_ID,),
        accepts_raw_body=True,
        body_fields=(
            BodyField("spreadsheet_id", "string", "spreadsheet_id", required=True),
            BodyField("is_active", "boolean", "is_active flag"),
            BodyField("script_id", "string", "Apps Script id"),
            BodyField("title", "string", "display title"),
            BodyField("template_name", "string", "template name"),
            BodyField("subscriptionExpiresAt", "string", "ISO date"),
        ),
    ),
    CommandSpec(
        name="update-client-spreadsheet",
        method="PATCH",
        path="/admin/client/:clientId/ss/:spreadsheetId",
        summary="PATCH /admin/client/:clientId/ss/:spreadsheetId",
        path_params=(CLIENT_ID, SS_ID),
        accepts_raw_body=True,
        body_fields=(
            BodyField("is_active", "boolean", "is_active flag"),
            BodyField("script_id", "string", "Apps Script id"),
            BodyField("title", "string", "display title"),
            BodyField("subscriptionExpiresAt", "string", "ISO date"),
        ),
    ),
    CommandSpec(
        name="delete-client-spreadsheet",
        method="DELETE",
        path="/admin/client/:clientId/ss/:spreadsheetId",
        summary="DELETE /admin/client/:clientId/ss/:spreadsheetId",
        path_params=(CLIENT_ID, SS_ID),
    ),
    # ─── /admin/client/:clientId/ss/:spreadsheetId/dataset ───────────────────
    CommandSpec(
        name="list-client-ss-datasets",
        method="GET",
        path="/admin/client/:clientId/ss/:spreadsheetId/dataset",
        summary="GET /admin/client/:clientId/ss/:spreadsheetId/dataset",
        path_params=(CLIENT_ID, SS_ID),
    ),
    CommandSpec(
        name="create-client-ss-dataset",
        method="POST",
        path="/admin/client/:clientId/ss/:spreadsheetId/dataset",
        summary="POST /admin/client/:clientId/ss/:spreadsheetId/dataset",
        path_params=(CLIENT_ID, SS_ID),
        accepts_raw_body=True,
        body_fields=(BodyField("dataset_name", "string", "dataset name", required=True),),
    ),
    CommandSpec(
        name="update-client-ss-dataset",
        method="PATCH",
        path="/admin/client/:clientId/ss/:spreadsheetId/dataset",
        summary="PATCH /admin/client/:clientId/ss/:spreadsheetId/dataset",
        path_params=(CLIENT_ID, SS_ID),
        accepts_raw_body=True,
        body_fields=(
            BodyField("dataset_name", "string", "dataset name"),
            BodyField("is_active", "boolean", "is_active flag"),
        ),
    ),
    CommandSpec(
        name="delete-client-ss-dataset",
        method="DELETE",
        path="/admin/client/:clientId/ss/:spreadsheetId/dataset",
        summary="DELETE /admin/client/:clientId/ss/:spreadsheetId/dataset",
        path_params=(CLIENT_ID, SS_ID),
        accepts_raw_body=True,
    ),
    # ─── /admin/client/:clientId/wb/token ────────────────────────────────────
    CommandSpec(
        name="list-client-wb-tokens",
        method="GET",
        path="/admin/client/:clientId/wb/token",
        summary="GET /admin/client/:clientId/wb/token",
        path_params=(CLIENT_ID,),
    ),
    CommandSpec(
        name="add-client-wb-token",
        method="POST",
        path="/admin/client/:clientId/wb/token",
        summary="POST /admin/client/:clientId/wb/token",
        path_params=(CLIENT_ID,),
        body_fields=(
            BodyField("token", "string", "WB JWT token", required=True),
            BodyField("description", "string", "free-text description"),
        ),
    ),
    CommandSpec(
        name="delete-client-wb-token",
        method="DELETE",
        path="/admin/client/:clientId/wb/token",
        summary="DELETE /admin/client/:clientId/wb/token",
        path_params=(CLIENT_ID,),
        body_fields=(BodyField("token", "string", "WB JWT token to delete", required=True),),
    ),
    CommandSpec(
        name="wb-token-seller-info",
        method="POST",
        path="/admin/client/:clientId/wb/token/seller-info",
        summary="POST /admin/client/:clientId/wb/token/seller-info",
        path_params=(CLIENT_ID,),
        body_fields=(BodyField("token", "string", "WB JWT token", required=True),),
    ),
    CommandSpec(
        name="wb-token-ping-content",
        method="POST",
        path="/admin/client/:clientId/wb/token/ping-content",
        summary="POST /admin/client/:clientId/wb/token/ping-content",
        path_params=(CLIENT_ID,),
        body_fields=(BodyField("token", "string", "WB JWT token", required=True),),
    ),
    # ─── /admin/client/:clientId/ozon/apikey ─────────────────────────────────
    CommandSpec(
        name="list-client-ozon-keys",
        method="GET",
        path="/admin/client/:clientId/ozon/apikey",
        summary="GET /admin/client/:clientId/ozon/apikey",
        path_params=(CLIENT_ID,),
    ),
    CommandSpec(
        name="add-client-ozon-key",
        method="POST",
        path="/admin/client/:clientId/ozon/apikey",
        summary="POST /admin/client/:clientId/ozon/apikey",
        path_params=(CLIENT_ID,),
        accepts_raw_body=True,
        body_fields=(
            BodyField("seller_client_id", "string", "Ozon seller client_id", required=True),
            BodyField("seller_api_key", "string", "Ozon seller API key", required=True),
            BodyField("performance_client_id", "string", "performance API client_id"),
            BodyField("performance_client_secret", "string", "performance API secret"),
            BodyField("name", "string", "display name"),
        ),
    ),
    CommandSpec(
        name="delete-client-ozon-key",
        method="DELETE",
        path="/admin/client/:clientId/ozon/apikey",
        summary="DELETE /admin/client/:clientId/ozon/apikey",
        path_params=(CLIENT_ID,),
        body_fields=(
            BodyField("seller_client_id", "string", "Ozon seller client_id", required=True),
        ),
    ),
    # ─── /admin/jobs/ss ──────────────────────────────────────────────────────
    CommandSpec(
        name="ss-jobs-queue-status",
        method="POST",
        path="/admin/jobs/ss/queue-status",
        summary="POST /admin/jobs/ss/queue-status",
        accepts_raw_body=True,
        body_fields=JOBS_BODY,
    ),
    CommandSpec(
        name="ss-jobs-active-jobs",
        method="POST",
        path="/admin/jobs/ss/active-jobs",
        summary="POST /admin/jobs/ss/active-jobs",
        accepts_raw_body=True,
        body_fields=JOBS_BODY,
    ),
    CommandSpec(
        name="ss-jobs-by-state",
        method="POST",
        path="/admin/jobs/ss/jobs-by-state",
        summary="POST /admin/jobs/ss/jobs-by-state",
        accepts_raw_body=True,
        body_fields=JOBS_BODY,
    ),
    CommandSpec(
        name="ss-jobs-job",
        method="POST",
        path="/admin/jobs/ss/job",
        summary="POST /admin/jobs/ss/job",
        accepts_raw_body=True,
        body_fields=JOBS_BODY,
    ),
    CommandSpec(
        name="ss-jobs-abort",
        method="POST",
        path="/admin/jobs/ss/abort",
        summary="POST /admin/jobs/ss/abort",
        accepts_raw_body=True,
        body_fields=JOBS_BODY,
    ),
    # ─── /admin/jobs/jobsControl/{wb,ozon,dataLoader} ────────────────────────
    *_jobs_group("wb-jobs", "wb"),
    *_jobs_group("ozon-jobs", "ozon"),
    *_jobs_group("dl-jobs", "dataLoader"),
    # ─── /admin/integrity ────────────────────────────────────────────────────
    CommandSpec(
        name="integrity-runs",
        method="POST",
        path="/admin/integrity/runs",
        summary="POST /admin/integrity/runs (cursor-paginated)",
        accepts_raw_body=True,
        body_fields=(
            BodyField("cursor", "json", "cursor object as JSON"),
            BodyField("limit", "number", "page size"),
            BodyField("sort", "string", "asc|desc"),
            BodyField("filter", "json", "filter object as JSON"),
        ),
    ),
    CommandSpec(
        name="integrity-findings",
        method="POST",
        path="/admin/integrity/findings",
        summary="POST /admin/integrity/findings (cursor-paginated)",
        accepts_raw_body=True,
        body_fields=(
            BodyField("cursor", "json", "cursor object as JSON"),
            BodyField("limit", "number", "page size"),
            BodyField("sort", "string", "asc|desc"),
            BodyField("status", "string", "open|resolved|all"),
            BodyField("filter", "json", "filter object as JSON"),
        ),
    ),
    CommandSpec(
        name="integrity-skips",
        method="POST",
        path="/admin/integrity/skips",
        summary="POST /admin/integrity/skips (cursor-paginated)",
        accepts_raw_body=True,
        body_fields=(
            BodyField("cursor", "json", "cursor object as JSON"),
            BodyField("limit", "number", "page size"),
            BodyField("sort", "string", "asc|desc"),
            BodyField("filter", "json", "filter object as JSON"),
        ),
    ),
    CommandSpec(
        name="integrity-trigger",
        method="POST",
        path="/admin/integrity/trigger",
        summary="POST /admin/integrity/trigger — manually trigger check (support_lead+)",
    ),
    # ─── /admin/cli ──────────────────────────────────────────────────────────
    CommandSpec(
        name="cli-run",
        method="POST",
        path="/admin/cli/run",
        summary="POST /admin/cli/run — execute CLI on remote server",
        accepts_raw_body=True,
        body_fields=(
            BodyField("server", "string", "target server name", required=True),
            BodyField(
                "name",
                "string",
                "<type>:<name> dispatch (e.g. service:users)",
                required=True,
            ),
            BodyField("method", "string", "method to call", required=True),
            BodyField("args", "json", "args object as JSON"),
            BodyField("requestId", "string", "optional request id"),
        ),
    ),
    CommandSpec(
        name="cli-manifest",
        method="POST",
        path="/admin/cli/manifest",
        summary="POST /admin/cli/manifest",
        body_fields=(BodyField("server", "string", "target server name", required=True),),
    ),
    CommandSpec(
        name="cli-servers",
        method="POST",
        path="/admin/cli/servers",
        summary="POST /admin/cli/servers — list available servers",
    ),
    CommandSpec(
        name="cli-log-subscribe",
        method="POST",
        path="/admin/cli/log-subscribe",
        summary="POST /admin/cli/log-subscribe",
        body_fields=(
            BodyField("key", "string", "log key", required=True),
            BodyField("level", "string", "log level"),
            BodyField("cliRequestId", "string", "CLI request id"),
        ),
    ),
    CommandSpec(
        name="cli-log-unsubscribe",
        method="POST",
        path="/admin/cli/log-unsubscribe",
        summary="POST /admin/cli/log-unsubscribe",
        body_fields=(
            BodyField("key", "string", "log key", required=True),
            BodyField("cliRequestId", "string", "CLI request id", required=True),
        ),
    ),
    CommandSpec(
        name="cli-log-heartbeat",
        method="POST",
        path="/admin/cli/log-heartbeat",
        summary="POST /admin/cli/log-heartbeat",
        body_fields=(
            BodyField("key", "string", "log key", required=True),
            BodyField("level", "string", "log level", required=True),
            BodyField("cliRequestId", "string", "CLI request id", required=True),
        ),
    ),
)


COMMANDS_BY_NAME: dict[str, CommandSpec] = {c.name: c for c in COMMANDS}
"""Index by short name (без префикса `mpuapi-`)."""

BIN_PREFIX = "mpuapi-"


def bin_name(spec: CommandSpec) -> str:
    return BIN_PREFIX + spec.name


def all_path_param_names(spec: CommandSpec) -> tuple[str, ...]:
    return tuple(p.name for p in spec.path_params)


# Sanity-check спека: все `:placeholder`-сегменты в `path` должны соответствовать
# `path_params` в том же порядке, и наоборот. Невалидный спек ловится при импорте.
def _validate_spec(spec: CommandSpec) -> None:
    placeholders = [seg[1:] for seg in spec.path.split("/") if seg.startswith(":")]
    declared = list(all_path_param_names(spec))
    if placeholders != declared:
        raise ValueError(
            f"command spec '{spec.name}': path placeholders {placeholders} "
            f"!= declared path_params {declared}"
        )
    field_names = [f.name for f in spec.body_fields]
    if len(field_names) != len(set(field_names)):
        raise ValueError(f"command spec '{spec.name}': duplicate body_fields")


def _validate_all() -> None:
    for spec in COMMANDS:
        _validate_spec(spec)
    if len({c.name for c in COMMANDS}) != len(COMMANDS):
        raise ValueError("duplicate command names in COMMANDS")


_validate_all()
