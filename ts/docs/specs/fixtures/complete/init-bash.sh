# mpu: дополнение строки (mpu-complete).
# Подключение: eval "$(mpu-complete init bash)" в ~/.bashrc.
_mpu_complete() {
  # Строка до курсора, а не COMP_WORDS: bash режет слово по ':'
  # (COMP_WORDBREAKS), и по COMP_WORDS «card: 123» не отличить от «card:123».
  local line=${COMP_LINE:0:COMP_POINT}
  local -a words
  read -r -a words <<<"$line"
  [[ -z $line || $line == *[[:space:]] ]] && words+=("")
  local cur=${words[${#words[@]}-1]}
  local IFS=$'\n'
  local -a found
  found=($(mpu-complete -- "${words[@]:1}" | cut -f1))
  # bash заменит только кусок слова после последнего ':' — отдать без
  # уже набранной части до него.
  local lead=""
  if [[ $cur == *:* && $COMP_WORDBREAKS == *:* ]]; then
    lead=${cur%"${cur##*:}"}
  fi
  COMPREPLY=("${found[@]#"$lead"}")
}
complete -F _mpu_complete mpu
