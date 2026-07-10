# Raspberry Pi 5 Setup Guide for PI4IOE5V96248 Control

This guide ensures your PI4IOE5V96248 control script works properly with Raspberry Pi 5.

## Key Differences in Raspberry Pi 5

1. **New GPIO chip**: Uses `/dev/gpiochip4` instead of `/dev/gpiochip0`
2. **WiringPi deprecated**: No longer maintained or officially supported
3. **libgpiod recommended**: Modern GPIO control library
4. **I2C should work unchanged**: Still uses `/dev/i2c-1` by default

## Required Installation Steps

### 1. Update System
```bash
sudo apt-get update
sudo apt-get upgrade
```

### 2. Install Required Packages
```bash
# Essential packages
sudo apt-get install i2c-tools gpiod

# Optional but helpful
sudo apt-get install python3-libgpiod
```

### 3. Enable I2C Interface
```bash
sudo raspi-config
# Navigate to: Interface Options -> I2C -> Yes
```

Or enable via command line:
```bash
sudo raspi-config nonint do_i2c 0
```

### 4. Verify I2C is Working
```bash
# Check I2C buses are available
ls -la /dev/i2c*

# Should show something like: /dev/i2c-1

# Test I2C detection (after connecting your chip)
i2cdetect -y 1
```

### 5. Verify GPIO Control
```bash
# Check if libgpiod tools are available
which gpioset
which gpioget

# Check GPIO chips
ls -la /dev/gpiochip*

# Should show: /dev/gpiochip4 (for Pi 5)
```

## Hardware Connections

### PI4IOE5V96248 → Raspberry Pi 5
- **VCC** → Pin 1 (3.3V) or Pin 2 (5V) depending on your chip variant
- **GND** → Pin 6 (Ground) or any other ground pin
- **SDA** → Pin 3 (GPIO 2, I2C1_SDA)
- **SCL** → Pin 5 (GPIO 3, I2C1_SCL)
- **RESET** → Pin 11 (GPIO 17) or any available GPIO pin
- **A0, A1, A2** → Configure for desired I2C address (0x20-0x27)

### Available GPIO Pins on Pi 5
Safe pins to use for RESET connection:
- GPIO 4, 17, 18, 22, 23, 24, 25, 27 (commonly available)
- Avoid GPIO 2, 3 (I2C), GPIO 14, 15 (UART)

## Testing the Setup

### 1. Test Basic Script Functionality
```bash
./pi4ioe5v96248_control.sh help
```

### 2. Test I2C Detection
```bash
./pi4ioe5v96248_control.sh detect
```

### 3. Test GPIO Control
```bash
# Set reset pin (example using GPIO 17)
sudo ./pi4ioe5v96248_control.sh set-reset-pin 17

# Test hardware reset
sudo ./pi4ioe5v96248_control.sh reset hard
```

### 4. Test Full Functionality
```bash
# Initialize chip
sudo ./pi4ioe5v96248_control.sh init

# Check status
./pi4ioe5v96248_control.sh status

# Test pin control
sudo ./pi4ioe5v96248_control.sh set-direction 0 output
sudo ./pi4ioe5v96248_control.sh set-output 0 1
./pi4ioe5v96248_control.sh read-all
```

## Troubleshooting

### Permission Issues
If you get permission errors:
```bash
# Add user to gpio group
sudo usermod -a -G gpio $USER

# Add user to i2c group
sudo usermod -a -G i2c $USER

# Log out and back in, or use:
newgrp gpio
newgrp i2c
```

### I2C Not Working
```bash
# Check if I2C is enabled in config
grep -q "^dtparam=i2c_arm=on" /boot/config.txt && echo "I2C enabled" || echo "I2C disabled"

# Manually enable if needed
echo "dtparam=i2c_arm=on" | sudo tee -a /boot/config.txt
sudo reboot
```

### GPIO Not Working
```bash
# Check if gpiod is properly installed
dpkg -l | grep gpiod

# Test direct GPIO control
gpioinfo
gpioset /dev/gpiochip4 17=1
gpioget /dev/gpiochip4 17
```

### No Device Found
```bash
# Check physical connections
# Verify I2C address configuration (A0, A1, A2 pins)
# Try different I2C addresses
for addr in {0x20..0x27}; do
    printf "Testing address $addr: "
    i2cget -y 1 $addr 0x00 2>/dev/null && echo "Found!" || echo "Not found"
done
```

## Performance Notes

- **libgpiod** is faster and more reliable than sysfs GPIO
- **Hardware reset** is more thorough than software reset
- **Run with sudo** if you encounter permission issues
- **Pi 5 is faster**: I2C operations complete more quickly than older Pi models

## Compatibility Matrix

| Method | Pi 5 | Pi 4 | Pi 3/2/1 | Recommended |
|--------|------|------|----------|-------------|
| libgpiod | ✅ Yes | ✅ Yes | ❓ Maybe | **Best for Pi 5** |
| WiringPi | ❌ No | ⚠️ Legacy | ✅ Yes | Deprecated |
| sysfs | ✅ Yes | ✅ Yes | ✅ Yes | Fallback only |

## Summary

Your script is now **Pi 5 compatible** with these updates:

1. ✅ **Detects GPIO chip** automatically (`/dev/gpiochip4` for Pi 5)
2. ✅ **Uses libgpiod** as the preferred GPIO control method
3. ✅ **Falls back gracefully** to WiringPi or sysfs if needed
4. ✅ **Provides clear setup instructions** for Pi 5
5. ✅ **Maintains backward compatibility** with older Pi models

The script should work reliably on Pi 5 once you install the required packages (`gpiod` and `i2c-tools`) and enable I2C via `raspi-config`.
