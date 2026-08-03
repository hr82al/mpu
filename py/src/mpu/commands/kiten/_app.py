"""Общий `typer.Typer` для `mpu kiten` — подмодули импортируют его отсюда и
декорируют свои команды (чтобы избежать циклов через пакетный `__init__`)."""

import typer

app = typer.Typer(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
    help=(
        "Kaiten (btlz.kaiten.ru) из терминала: `ls`/`card`/`comment`/`desc`/`move`/`ready`/"
        "`review`/`close` — работа с карточкой; `checklist` — чек-листы (интерактивные "
        "чекбоксы); `time` — учёт времени и таймер; `field` — кастомные поля; `status` — "
        "вся моя работа одной матрицей; `spaces`/`boards`/`lanes`/`columns`/`roles`/"
        "`whoami` — справочник."
    ),
)
