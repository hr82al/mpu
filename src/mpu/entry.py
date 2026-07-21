"""Точка входа бинаря `mpu`: обёртка лога вызовов вокруг всего процесса.

Тонкая по замыслу: `mpu.cli` на уровне модуля выполняет `_mount(app, COMMANDS)`, то есть
жадно импортирует все команды. Обёртка внутри `cli.main()` этот импорт не покрывала бы —
падение на импорте не попало бы в лог, а длительность вызова оказалась бы занижена.
Поэтому `mpu.cli` импортируется уже ВНУТРИ `invocation_log()`.
"""


def main() -> None:
    """Запустить CLI под логом вызовов (`mpu.lib.log`)."""
    from mpu.lib.log import invocation_log  # import-light: только .env, без mpu.db

    with invocation_log():
        from mpu.cli import main as cli_main

        cli_main()
