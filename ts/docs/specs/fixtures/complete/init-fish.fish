# mpu-next: дополнение строки (mpu-complete).
# Подключение: mpu-complete init fish | source (в ~/.config/fish/config.fish).
complete -c mpu-next -f -a '(mpu-complete -- (commandline -opc)[2..] (commandline -ct))'
