"""Registry подкоманд `mpu` — источник истины для монтажа в `cli.py`.

Структура соответствует трём namespace'ам root Typer-app:
- `PRINT_COMMANDS`: смонтированы в root, дефолт = print + clipboard (бывший `mpu-X`).
- `PORTAINER_COMMANDS`: смонтированы в `p`-subgroup, дефолт = exec через Portainer
  (бывший `mpup-X`). `--print` callback'а возвращает в print-mode.

`api`-namespace строится из `mpu.commands._mpuapi_spec.COMMANDS` динамически —
в registry не входит.

Pairs (X есть и в PRINT_COMMANDS, и в PORTAINER_COMMANDS) переиспользуют ту же
`commands.<module>.app` — поведение различает `MPU_WRAPPER` env, который ставит
`_p_root` callback в `cli.py` до диспатча subcommand.
"""

from __future__ import annotations

# kebab-name → (module, attribute). 34 команды без portainer-варианта + 22 пары.
PRINT_COMMANDS: dict[str, tuple[str, str]] = {
    "search": ("mpu.commands.search", "app"),
    "update": ("mpu.commands.update", "app"),
    "sql": ("mpu.commands.sql", "app"),
    # Passthrough-обёртки `new-mpu` (см. mpu.lib.new_mpu). Будут заменены нативной
    # реализацией по мере переноса из Go/Node CLI.
    "sheet": ("mpu.commands.sheet", "app"),
    "xlsx": ("mpu.commands.xlsx", "app"),
    "db": ("mpu.commands.db", "app"),
    "backup-wb-unit-proto": ("mpu.commands.backup_wb_unit_proto", "app"),
    "backup-ozon-unit-proto": ("mpu.commands.backup_ozon_unit_proto", "app"),
    "backup-wb-unit-manual-data": ("mpu.commands.backup_wb_unit_manual_data", "app"),
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
    "d2-miro": ("mpu.commands.d2_miro", "app"),
    "run-js": ("mpu.commands.run_js", "app"),
    "copy-client": ("mpu.commands.copy_client", "app"),
    "copy-shared": ("mpu.commands.copy_shared", "app"),
    "move-client": ("mpu.commands.move_client", "app"),
    "logs": ("mpu.commands.logs", "app"),
    "help": ("mpu.commands.help", "app"),
}

# `mpu p X` — 22 пары (имеют mpu-X партнёра, общий `app`, разный wrapper через env)
# + 3 уникальные Portainer-only (ssh/ps/health не читают MPU_WRAPPER, callback env
# для них безвреден).
PORTAINER_COMMANDS: dict[str, tuple[str, str]] = {
    "data-loader": ("mpu.commands.data_loader", "app"),
    "data-loader-jobs": ("mpu.commands.data_loader_jobs", "app"),
    "users": ("mpu.commands.users", "app"),
    "iu-wb": ("mpu.commands.iu_wb", "app"),
    "ss-datasets": ("mpu.commands.ss_datasets", "app"),
    "ss-load": ("mpu.commands.ss_load", "app"),
    "ss-update": ("mpu.commands.ss_update", "app"),
    "ozon-loader": ("mpu.commands.ozon_loader", "app"),
    "ozon-jobs": ("mpu.commands.ozon_jobs", "app"),
    "wb-loader": ("mpu.commands.wb_loader", "app"),
    "wb-jobs": ("mpu.commands.wb_jobs", "app"),
    "wb-unit-calc": ("mpu.commands.wb_unit_calc", "app"),
    "wb-unit-proto-new": ("mpu.commands.wb_unit_proto_new", "app"),
    "clients-migrations": ("mpu.commands.clients_migrations", "app"),
    "datasets-migrations": ("mpu.commands.datasets_migrations", "app"),
    "app-migrations": ("mpu.commands.app_migrations", "app"),
    "process": ("mpu.commands.process", "app"),
    "wb-save-expenses": ("mpu.commands.save_wb_expenses", "app"),
    "ozon-save-expenses": ("mpu.commands.save_ozon_expenses", "app"),
    "wb-recalculate-expenses": ("mpu.commands.recalculate_wb_expenses", "app"),
    "ozon-recalculate-expenses": ("mpu.commands.recalculate_ozon_expenses", "app"),
    "ssh": ("mpu.commands.pssh", "app"),
    "ps": ("mpu.commands.ps", "app"),
    "health": ("mpu.commands.health", "app"),
}
