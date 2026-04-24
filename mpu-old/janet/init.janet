# init.janet — Final initialization after all modules are loaded.
#
# Loaded last by the Go REPL. All highlight/, help/, completion/,
# prompt/, and prelude functions are already available.
#
# Users can create rc.janet in the same directory for personal overrides.

# Nothing extra needed — modules are loaded by Go in order.
# This file exists as a hook point and for user documentation.
#
# To customize your REPL, create rc.janet in your janet directory
# (~/.config/mpu/janet/rc.janet by default):
#
#   # Custom prompt
#   (set-prompt (fn [] (string "λ:" *counter* "> ")))
#
#   # Aliases
#   (defn gs [id name] (mpu/get "-s" id "-n" name))
#
#   # Auto-load a module
#   (%load "/path/to/my/lib.janet")
