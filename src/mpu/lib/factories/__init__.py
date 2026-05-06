"""Фабрики subcommand'ов для семейств `node cli service:<name> <method>` с общим shape флагов.

Каждая фабрика регистрирует subcommand'ы в готовый `typer.Typer`. Используется в
`mpu/commands/<entry>.py` модулях для устранения копипасты — модуль команды сводится
к импорту фабрики + декларации списка `(sub_name, sl_back_method_name)`.
"""
