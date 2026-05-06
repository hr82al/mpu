"""Скопировать текст в системный буфер обмена.

Стратегия: сначала OSC 52 (escape-последовательность, работает поверх SSH и в TTY,
требует поддержки в терминале), потом внешние утилиты wl-copy/xclip/xsel.
Все ошибки молча проглатываются — команда уже напечатана в stdout, копирование bonus.
"""

import base64
import os
import shutil
import subprocess


def _try_osc52(text: str) -> bool:
    encoded = base64.b64encode(text.encode()).decode("ascii")
    seq = f"\x1b]52;c;{encoded}\x07"
    if os.environ.get("TMUX"):
        # tmux passthrough: оборачиваем в DCS, иначе tmux съест последовательность.
        seq = f"\x1bPtmux;\x1b{seq}\x1b\\"
    try:
        with open("/dev/tty", "w") as tty:
            tty.write(seq)
            tty.flush()
        return True
    except OSError:
        return False


def _try_external(text: str) -> bool:
    candidates = [
        ["wl-copy"],
        ["xclip", "-selection", "clipboard"],
        ["xsel", "--clipboard", "--input"],
    ]
    for cmd in candidates:
        if shutil.which(cmd[0]) is None:
            continue
        try:
            subprocess.run(
                cmd,
                input=text.encode(),
                check=True,
                timeout=2,
                stderr=subprocess.DEVNULL,
            )
            return True
        except (OSError, subprocess.SubprocessError):
            continue
    return False


def copy_to_clipboard(text: str) -> bool:
    """Скопировать текст. True если получилось хоть как-то, False — silent skip."""
    if _try_osc52(text):
        return True
    return _try_external(text)
