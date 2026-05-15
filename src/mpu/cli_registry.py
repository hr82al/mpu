"""Registry подкоманд `mpu` — источник истины для монтажа в `cli.py`.

Все доменные команды смонтированы в root `app`. Дефолтное поведение — выполнение
inner-команды (через Portainer для node-CLI обёрток, нативно для native-команд).
Опция `--print` / `-p` в node-CLI-обёртках возвращает в print + clipboard режим.

`api`-namespace строится из `mpu.commands._mpuapi_spec.COMMANDS` динамически —
в registry не входит.
"""

from __future__ import annotations

# kebab-name → (module, attribute).
COMMANDS: dict[str, tuple[str, str]] = {
    # ── Native команды (не проксируют sl-back, не имеют --print) ────────────
    "search": ("mpu.commands.search", "app"),
    "update": ("mpu.commands.update", "app"),
    "sql": ("mpu.commands.sql", "app"),
    # Passthrough-обёртки `new-mpu` (см. mpu.lib.new_mpu). Будут заменены нативной
    # реализацией по мере переноса из Go/Node CLI.
    "sheet": ("mpu.commands.sheet", "app"),
    "xlsx": ("mpu.commands.xlsx", "app"),
    "backup-wb-unit-proto": ("mpu.commands.backup_wb_unit_proto", "app"),
    "backup-ozon-unit-proto": ("mpu.commands.backup_ozon_unit_proto", "app"),
    "backup-wb-unit-manual-data": ("mpu.commands.backup_wb_unit_manual_data", "app"),
    "d2-miro": ("mpu.commands.d2_miro", "app"),
    "run-js": ("mpu.commands.run_js", "app"),
    "copy-client": ("mpu.commands.copy_client", "app"),
    "copy-shared": ("mpu.commands.copy_shared", "app"),
    "move-client": ("mpu.commands.move_client", "app"),
    "logs": ("mpu.commands.logs", "app"),
    "help": ("mpu.commands.help", "app"),
    # ── Node-CLI обёртки (имеют --print / -p) ───────────────────────────────
    "wb-recalculate-expenses": ("mpu.commands.recalculate_wb_expenses", "app"),
    "wb-save-expenses": ("mpu.commands.save_wb_expenses", "app"),
    "process": ("mpu.commands.process", "app"),
    "ss-update": ("mpu.commands.ss_update", "app"),
    "ss-load": ("mpu.commands.ss_load", "app"),
    "ss-datasets": ("mpu.commands.ss_datasets", "app"),
    "wb-loader": ("mpu.commands.wb_loader", "app"),
    "wb-jobs": ("mpu.commands.wb_jobs", "app"),
    "wb-unit-calc": ("mpu.commands.wb_unit_calc", "app"),
    "wb-unit-proto-new": ("mpu.commands.wb_unit_proto_new", "app"),
    "iu-wb": ("mpu.commands.iu_wb", "app"),
    "ozon-loader": ("mpu.commands.ozon_loader", "app"),
    "ozon-jobs": ("mpu.commands.ozon_jobs", "app"),
    "ozon-recalculate-expenses": ("mpu.commands.recalculate_ozon_expenses", "app"),
    "ozon-save-expenses": ("mpu.commands.save_ozon_expenses", "app"),
    "clients-migrations": ("mpu.commands.clients_migrations", "app"),
    "datasets-migrations": ("mpu.commands.datasets_migrations", "app"),
    "app-migrations": ("mpu.commands.app_migrations", "app"),
    "users": ("mpu.commands.users", "app"),
    "data-loader": ("mpu.commands.data_loader", "app"),
    "data-loader-jobs": ("mpu.commands.data_loader_jobs", "app"),
    # ── Portainer-only утилиты (exec-only, нет смысла в --print) ────────────
    "ssh": ("mpu.commands.pssh", "app"),
    "ps": ("mpu.commands.ps", "app"),
    "health": ("mpu.commands.health", "app"),
}
