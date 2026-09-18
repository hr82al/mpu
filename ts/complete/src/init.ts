/**
 * Скрипты подключения дополнения (`specs/complete.md`, «`init`»). Скрипт
 * — только обвязка: слова строки уходят `mpu-complete`, варианты с
 * описаниями приходят оттуда же. Эталоны — `fixtures/complete/init-*`.
 */

/** Оболочки, для которых есть скрипт. */
const SHELLS = ["bash", "fish", "nu"] as const;
export type Shell = typeof SHELLS[number];

/** Оболочка по имени; не поддерживается — `undefined`. */
export function shellOf(name: string): Shell | undefined {
  return SHELLS.find((shell) => shell === name);
}

export const SHELL_NAMES = SHELLS.join(", ");

/** Имя программы как часть имени функции оболочки. */
function ident(command: string): string {
  return command.replace(/[^A-Za-z0-9_]/g, "_");
}

function bash(command: string): string {
  const fn = `_${ident(command)}_complete`;
  return `# ${command}: дополнение строки (mpu-complete).
# Подключение: eval "$(mpu-complete init bash)" в ~/.bashrc.
${fn}() {
  # Строка до курсора, а не COMP_WORDS: bash режет слово по ':'
  # (COMP_WORDBREAKS), и по COMP_WORDS «card: 123» не отличить от «card:123».
  local line=\${COMP_LINE:0:COMP_POINT}
  local -a words
  read -r -a words <<<"$line"
  [[ -z $line || $line == *[[:space:]] ]] && words+=("")
  local cur=\${words[\${#words[@]}-1]}
  local IFS=$'\\n'
  local -a found
  found=($(mpu-complete -- "\${words[@]:1}" | cut -f1))
  # bash заменит только кусок слова после последнего ':' — отдать без
  # уже набранной части до него.
  local lead=""
  if [[ $cur == *:* && $COMP_WORDBREAKS == *:* ]]; then
    lead=\${cur%"\${cur##*:}"}
  fi
  COMPREPLY=("\${found[@]#"$lead"}")
}
complete -F ${fn} ${command}
`;
}

function fish(command: string): string {
  return `# ${command}: дополнение строки (mpu-complete).
# Подключение: mpu-complete init fish | source (в ~/.config/fish/config.fish).
complete -c ${command} -f -a '(mpu-complete -- (commandline -opc)[2..] (commandline -ct))'
`;
}

function nu(command: string): string {
  const previous = `${ident(command)}_previous_completer`;
  return `# ${command}: дополнение строки (mpu-complete).
# Подключение: сохранить вывод в файл и подключить его в config.nu
# командой source <файл>. Прежний внешний дополнитель не затирается:
# для прочих команд вызывается он.
let ${previous} = $env.config.completions.external.completer?
$env.config.completions.external = {
  enable: true
  completer: {|spans|
    if ($spans.0 == "${command}") {
      ^mpu-complete -- ...($spans | skip 1)
        | lines
        | each {|row| $row | split column "\\t" value description | first }
    } else if ($${previous} != null) {
      do $${previous} $spans
    } else {
      null
    }
  }
}
`;
}

const SCRIPTS: Readonly<Record<Shell, (command: string) => string>> = {
  bash,
  fish,
  nu,
};

/**
 * Скрипт подключения.
 *
 * @param shell оболочка
 * @param command имя дополняемой программы
 */
export function initScript(shell: Shell, command: string): string {
  return SCRIPTS[shell](command);
}
