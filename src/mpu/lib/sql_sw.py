"""sw-PG (база sw-back `workspaces`) для `mpu sql`: SQL выполняется ВНУТРИ контейнера sw-back.

Prod sw-PG закрыт `pg_hba.conf` на всё, кроме app-хоста sw-back, поэтому коннект
с машины разработчика (или с sl-N) не проходит. Единственный рабочий путь —
выполнить SQL изнутри контейнера sw-back тем же механизмом, что `mpu run-js`
(`pssh`: Portainer-exec / ssh+docker): там есть драйвер `pg` в node_modules и
`DATABASE_URL` в env, а коннект к PG идёт с разрешённого хоста.

SQL оборачивается в одноразовый ESM-скрипт (pg.Client), результат сериализуется
в одну маркер-строку и печатается теми же форматтерами, что у стандартного
селектора (`sql_runner.print_table` / `print_md_table` / `--json`).

Конфиг в `~/.config/mpu/.env` (всё опционально):
  SW_PG_RUN_TARGET — где выполнять: точное имя контейнера из Portainer-кэша
                     (default `sw-api`) или `sl-N`. Контейнер должен быть в
                     `mpu init`-кэше (Portainer endpoint sw-хоста).
  SW_PG_DSN_ENV    — имя env-переменной с DSN внутри контейнера (default
                     `DATABASE_URL`).
  SW_PG_DSN        — override DSN литералом (если не хочется брать из env
                     контейнера); коннект всё равно идёт изнутри контейнера.

Prisma-параметры query-string (`?schema=public`, …) вычищаются — драйвер `pg`
их не понимает. Write-защита — тот же `sql_guard` (`PROTECT=false` снимает).
"""

import json
import sys
from typing import IO, Any

from mpu.lib import containers, pssh, servers, sql_guard
from mpu.lib.sql_runner import print_md_table, print_table

SW_ALIASES = frozenset({"sw", "sw-pg", "swpg", "sw-back", "swback", "ws", "workspaces"})

_NODE_CMD = ["node", "--input-type=module", "-"]
_RESULT_MARKER = "__MPU_SW_SQL_RESULT__"
_DEFAULT_RUN_TARGET = "sw-api"
_DEFAULT_DSN_ENV = "DATABASE_URL"

# Подстановка через .replace (не f-string) — в JS-теле много фигурных скобок.
_JS_TEMPLATE = """\
import pg from "pg";

const dsnRaw = __DSN_EXPR__;
if (!dsnRaw) {
    console.error("mpu sql sw: пустой DSN (нет env " + __VAR_JSON__ + " и не задан SW_PG_DSN)");
    process.exit(3);
}
const url = new URL(String(dsnRaw));
const prismaParams = ["schema", "connection_limit", "pool_timeout", "pgbouncer", "socket_timeout"];
for (const p of prismaParams) url.searchParams.delete(p);

const client = new pg.Client({ connectionString: url.toString() });
await client.connect();
try {
    const res = await client.query({ text: __SQL_JSON__, rowMode: "array" });
    const last = Array.isArray(res) ? res[res.length - 1] : res;
    const fields = last.fields ?? [];
    console.log(__MARKER_JSON__ + JSON.stringify({
        cols: fields.map((f) => f.name),
        rows: last.rows ?? [],
        rowCount: last.rowCount ?? 0,
        hasResultSet: fields.length > 0,
    }));
} finally {
    await client.end();
}
"""


def is_sw_selector(value: str) -> bool:
    """`"sw"` / `"sw-pg"` / `"ws"` / `"workspaces"` (case-insensitive) → True."""
    return value.strip().lower() in SW_ALIASES


def _run_target() -> str:
    return (servers.env_value("SW_PG_RUN_TARGET") or _DEFAULT_RUN_TARGET).strip()


def _dsn_env_var() -> str:
    return (servers.env_value("SW_PG_DSN_ENV") or _DEFAULT_DSN_ENV).strip()


def _dsn_js_expr(var: str) -> str:
    """JS-выражение источника DSN: литерал SW_PG_DSN (если задан) либо env контейнера."""
    override = servers.env_value("SW_PG_DSN")
    if override and override.strip():
        return json.dumps(override.strip())
    return f"process.env[{json.dumps(var)}]"


def _build_js(sql: str, var: str) -> str:
    return (
        _JS_TEMPLATE.replace("__DSN_EXPR__", _dsn_js_expr(var))
        .replace("__VAR_JSON__", json.dumps(var))
        .replace("__SQL_JSON__", json.dumps(sql))
        .replace("__MARKER_JSON__", json.dumps(_RESULT_MARKER))
    )


def _extract_payload(stdout_text: str) -> dict[str, Any] | None:
    for line in reversed(stdout_text.splitlines()):
        if line.startswith(_RESULT_MARKER):
            try:
                data: dict[str, Any] = json.loads(line[len(_RESULT_MARKER) :])
            except json.JSONDecodeError:
                return None
            return data
    return None


def run_sql_sw(
    sql: str,
    *,
    dry: bool = False,
    json_out: bool = False,
    md_out: bool = False,
    verbose: bool = False,
    stdout: IO[str] | None = None,
    stderr: IO[str] | None = None,
) -> int:
    """Выполнить SQL на sw-PG изнутри контейнера sw-back. Возвращает exit code.

    Семантика флагов и формат вывода — как у `sql_runner.run_sql`: `--dry`
    печатает meta без exec, guard блокирует модифицирующие запросы при `PROTECT`
    (default), результат — таблица / `--json` / `--md`, statement без result-set
    → `OK (rowcount=N)`.
    """
    out = stdout if stdout is not None else sys.stdout
    err = stderr if stderr is not None else sys.stderr

    target = _run_target()
    var = _dsn_env_var()

    if verbose or dry:
        override = servers.env_value("SW_PG_DSN")
        dsn_src = "SW_PG_DSN (override)" if override and override.strip() else f"env {var}"
        print("server: sw-pg (база sw-back)", file=err)
        print(f"run_target: {target}", file=err)
        print(f"dsn_source: {dsn_src} (коннект изнутри контейнера)", file=err)
        print("sql:", file=err)
        print(sql, file=err)
    if dry:
        return 0

    if sql_guard.is_protected():
        try:
            sql_guard.check_read_only(sql)
        except sql_guard.SqlGuardError as e:
            print(f"mpu sql: {e}", file=err)
            return 1

    js = _build_js(sql, var)
    out_buf = bytearray()
    err_buf = bytearray()
    server_n = servers.server_number(target)
    try:
        if server_n is not None:
            rc = pssh.pssh_run(
                server_number=server_n,
                cmd=_NODE_CMD,
                stdin=js.encode("utf-8"),
                on_stdout=out_buf.extend,
                on_stderr=err_buf.extend,
            )
        else:
            rc = pssh.pssh_run_container(
                container=target,
                cmd=_NODE_CMD,
                stdin=js.encode("utf-8"),
                on_stdout=out_buf.extend,
                on_stderr=err_buf.extend,
            )
    except containers.ContainerResolveError as e:
        print(
            f"mpu sql sw: контейнер {target!r} не резолвится ({e}).\n"
            "  Нужен Portainer endpoint sw-хоста в кэше `mpu init`, либо задай "
            "SW_PG_RUN_TARGET (sl-N / имя контейнера).",
            file=err,
        )
        return 2

    stdout_text = out_buf.decode("utf-8", errors="replace")
    payload = _extract_payload(stdout_text)
    if rc != 0 or payload is None:
        if err_buf:
            err.write(err_buf.decode("utf-8", errors="replace"))
        leftover = "\n".join(
            ln for ln in stdout_text.splitlines() if not ln.startswith(_RESULT_MARKER)
        ).strip()
        if leftover:
            print(leftover, file=err)
        reason = "результат не найден в выводе" if payload is None else f"exit={rc}"
        print(f"mpu sql sw: выполнение не удалось ({reason})", file=err)
        return 1

    cols_raw: list[Any] = payload.get("cols") or []
    rows_raw: list[Any] = payload.get("rows") or []
    cols: list[str] = [str(c) for c in cols_raw]
    rows: list[tuple[Any, ...]] = [tuple(r) for r in rows_raw]

    if not payload.get("hasResultSet"):
        rowcount = int(payload.get("rowCount") or 0)
        if json_out:
            print(json.dumps({"ok": True, "rowcount": rowcount}), file=out)
        else:
            print(f"OK (rowcount={rowcount})", file=out)
        return 0

    if json_out:
        print(
            json.dumps(
                [dict(zip(cols, r, strict=False)) for r in rows],
                ensure_ascii=False,
                default=str,
            ),
            file=out,
        )
    elif md_out:
        print_md_table(cols, rows, out)
    else:
        print_table(cols, rows, out)
    return 0
