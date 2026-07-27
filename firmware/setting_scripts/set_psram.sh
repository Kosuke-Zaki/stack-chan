#!/bin/sh

# Get the path to the configuration file
SDKCONFIG="$HOME/.local/share/moddable/build/devices/esp32/targets/m5stack_cores3/sdkconfig/sdkconfig.defaults"

# Ensure compatibility between macOS and Linux sed command
if [ "$(uname)" = "Darwin" ]; then
    # macOS
    sed -i '' 's/CONFIG_SPIRAM=n/CONFIG_SPIRAM=y/' "$SDKCONFIG"
else
    # Linux
    sed -i 's/CONFIG_SPIRAM=n/CONFIG_SPIRAM=y/' "$SDKCONFIG"
fi

# Display the result
cat "$SDKCONFIG"
