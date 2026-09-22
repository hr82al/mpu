# mpu: дополнение строки (mpu-complete).
# Подключение: сохранить вывод в файл и подключить его в config.nu
# командой source <файл>. Прежний внешний дополнитель не затирается:
# для прочих команд вызывается он.
let mpu_previous_completer = $env.config.completions.external.completer?
$env.config.completions.external = {
  enable: true
  completer: {|spans|
    if ($spans.0 == "mpu") {
      ^mpu-complete -- ...($spans | skip 1)
        | lines
        | each {|row| $row | split column "\t" value description | first }
    } else if ($mpu_previous_completer != null) {
      do $mpu_previous_completer $spans
    } else {
      null
    }
  }
}
