#!/bin/bash

# PI4IOE5V96248 I2C GPIO Expander Control Script for Raspberry Pi 5
# This script provides functions to control the 48-bit I2C GPIO expander
#
# Author: Generated for Walker Labs Master Control
# Date: $(date)

# Default I2C device and address
I2C_BUS="/dev/i2c-1"
I2C_ADDR="0x20"  # Default address (can be 0x20-0x27 based on A0,A1,A2 pins)

# Reset pin configuration
RESET_PIN="17"    # Default GPIO pin connected to the RESET pin (BCM numbering)

# PI4IOE5V96248 Register Map
declare -A REGISTERS=(
    ["INPUT_PORT0"]="0x00"
    ["INPUT_PORT1"]="0x01"
    ["INPUT_PORT2"]="0x02"
    ["INPUT_PORT3"]="0x03"
    ["INPUT_PORT4"]="0x04"
    ["INPUT_PORT5"]="0x05"
    ["OUTPUT_PORT0"]="0x08"
    ["OUTPUT_PORT1"]="0x09"
    ["OUTPUT_PORT2"]="0x0A"
    ["OUTPUT_PORT3"]="0x0B"
    ["OUTPUT_PORT4"]="0x0C"
    ["OUTPUT_PORT5"]="0x0D"
    ["POLARITY_INV0"]="0x10"
    ["POLARITY_INV1"]="0x11"
    ["POLARITY_INV2"]="0x12"
    ["POLARITY_INV3"]="0x13"
    ["POLARITY_INV4"]="0x14"
    ["POLARITY_INV5"]="0x15"
    ["CONFIG0"]="0x18"
    ["CONFIG1"]="0x19"
    ["CONFIG2"]="0x1A"
    ["CONFIG3"]="0x1B"
    ["CONFIG4"]="0x1C"
    ["CONFIG5"]="0x1D"
    ["DRIVE_STRENGTH0_0"]="0x20"
    ["DRIVE_STRENGTH0_1"]="0x21"
    ["DRIVE_STRENGTH1_0"]="0x22"
    ["DRIVE_STRENGTH1_1"]="0x23"
    ["DRIVE_STRENGTH2_0"]="0x24"
    ["DRIVE_STRENGTH2_1"]="0x25"
    ["INPUT_LATCH0"]="0x44"
    ["INPUT_LATCH1"]="0x45"
    ["INPUT_LATCH2"]="0x46"
    ["INPUT_LATCH3"]="0x47"
    ["INPUT_LATCH4"]="0x48"
    ["INPUT_LATCH5"]="0x49"
    ["PULL_ENABLE0"]="0x4C"
    ["PULL_ENABLE1"]="0x4D"
    ["PULL_ENABLE2"]="0x4E"
    ["PULL_ENABLE3"]="0x4F"
    ["PULL_ENABLE4"]="0x50"
    ["PULL_ENABLE5"]="0x51"
    ["PULL_SELECT0"]="0x54"
    ["PULL_SELECT1"]="0x55"
    ["PULL_SELECT2"]="0x56"
    ["PULL_SELECT3"]="0x57"
    ["PULL_SELECT4"]="0x58"
    ["PULL_SELECT5"]="0x59"
    ["INT_MASK0"]="0x5C"
    ["INT_MASK1"]="0x5D"
    ["INT_MASK2"]="0x5E"
    ["INT_MASK3"]="0x5F"
    ["INT_MASK4"]="0x60"
    ["INT_MASK5"]="0x61"
    ["INT_STATUS0"]="0x64"
    ["INT_STATUS1"]="0x65"
    ["INT_STATUS2"]="0x66"
    ["INT_STATUS3"]="0x67"
    ["INT_STATUS4"]="0x68"
    ["INT_STATUS5"]="0x69"
)

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging function
log() {
    echo -e "${BLUE}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

# Check if running on Raspberry Pi
check_raspberry_pi() {
    if [[ ! -f /proc/device-tree/model ]]; then
        error "This script is designed to run on Raspberry Pi"
        return 1
    fi

    local model=$(cat /proc/device-tree/model 2>/dev/null)
    if [[ "$model" == *"Raspberry Pi 5"* ]]; then
        log "Running on Raspberry Pi 5"
        return 0
    else
        warning "This script is optimized for Raspberry Pi 5, but will attempt to run on: $model"
        return 0
    fi
}

# Check if I2C is enabled and i2c-tools are installed
check_i2c_setup() {
    # Check if I2C is enabled
    if ! ls /dev/i2c* >/dev/null 2>&1; then
        error "I2C interface not found. Enable I2C using 'sudo raspi-config'"
        error "Navigate to: Interfacing Options -> I2C -> Enable"
        return 1
    fi

    # Check if i2c-tools are installed
    if ! command -v i2cdetect >/dev/null 2>&1; then
        error "i2c-tools not found. Install with: sudo apt-get install i2c-tools"
        return 1
    fi

    # Check if the I2C bus exists
    if [[ ! -e "$I2C_BUS" ]]; then
        error "I2C bus $I2C_BUS not found"
        return 1
    fi

    # Check GPIO control options (Pi 5 compatible)
    local gpio_method="none"
    if command -v gpioset >/dev/null 2>&1 && command -v gpioget >/dev/null 2>&1; then
        gpio_method="libgpiod"
        log "Using libgpiod tools (recommended for Pi 5)"
    elif command -v gpio >/dev/null 2>&1; then
        gpio_method="wiringpi"
        warning "Using WiringPi (deprecated, may not work on Pi 5)"
    elif [ -d "/sys/class/gpio" ]; then
        gpio_method="sysfs"
        log "Using sysfs GPIO interface (fallback)"
    else
        warning "No GPIO control method available."
        warning "Install libgpiod-tools: sudo apt-get install gpiod"
        warning "Reset pin functionality will be limited"
    fi

    success "I2C setup verified (GPIO method: $gpio_method)"
    return 0
}

# Detect PI4IOE5V96248 on I2C bus
detect_chip() {
    log "Scanning I2C bus for PI4IOE5V96248..."

    # Scan for devices on I2C bus 1
    local devices=$(i2cdetect -y 1 2>/dev/null | grep -E '[0-9a-f]{2}' | grep -v '^$')

    if [[ -z "$devices" ]]; then
        error "No I2C devices found on bus 1"
        return 1
    fi

    log "I2C devices found:"
    i2cdetect -y 1

    # Try common addresses for PI4IOE5V96248 (0x20-0x27)
    for addr in {0x20..0x27}; do
        local hex_addr=$(printf "0x%02x" $addr)
        if i2cget -y 1 $addr 0x00 >/dev/null 2>&1; then
            success "PI4IOE5V96248 detected at address $hex_addr"
            I2C_ADDR=$hex_addr
            return 0
        fi
    done

    warning "PI4IOE5V96248 not found at common addresses. Using default address $I2C_ADDR"
    return 0
}

# Read from I2C register
i2c_read() {
    local reg=$1
    if [[ -z "$reg" ]]; then
        error "Register address required"
        return 1
    fi

    local result=$(i2cget -y 1 ${I2C_ADDR} ${reg} 2>/dev/null)
    if [[ $? -eq 0 ]]; then
        echo $result
        return 0
    else
        error "Failed to read register $reg"
        return 1
    fi
}

# Write to I2C register
i2c_write() {
    local reg=$1
    local value=$2

    if [[ -z "$reg" || -z "$value" ]]; then
        error "Register address and value required"
        return 1
    fi

    if i2cset -y 1 ${I2C_ADDR} ${reg} ${value} 2>/dev/null; then
        return 0
    else
        error "Failed to write $value to register $reg"
        return 1
    fi
}

# Initialize the PI4IOE5V96248
init_chip() {
    log "Initializing PI4IOE5V96248..."

    # Set all pins as inputs initially (CONFIG registers: 1=input, 0=output)
    for i in {0..5}; do
        if ! i2c_write ${REGISTERS["CONFIG$i"]} 0xFF; then
            error "Failed to initialize CONFIG$i register"
            return 1
        fi
    done

    # Clear output registers
    for i in {0..5}; do
        if ! i2c_write ${REGISTERS["OUTPUT_PORT$i"]} 0x00; then
            error "Failed to clear OUTPUT_PORT$i register"
            return 1
        fi
    done

    success "PI4IOE5V96248 initialized successfully"
    return 0
}

# Set pin direction (0=output, 1=input)
set_pin_direction() {
    local pin=$1
    local direction=$2  # "input" or "output"

    if [[ -z "$pin" || -z "$direction" ]]; then
        error "Usage: set_pin_direction <pin_number> <input|output>"
        return 1
    fi

    if [[ $pin -lt 0 || $pin -gt 47 ]]; then
        error "Pin number must be between 0 and 47"
        return 1
    fi

    local port=$((pin / 8))
    local bit=$((pin % 8))
    local reg=${REGISTERS["CONFIG$port"]}

    # Read current config
    local current=$(i2c_read $reg)
    if [[ $? -ne 0 ]]; then
        return 1
    fi

    local current_dec=$((current))

    if [[ "$direction" == "output" ]]; then
        # Clear bit for output
        local new_value=$((current_dec & ~(1 << bit)))
    elif [[ "$direction" == "input" ]]; then
        # Set bit for input
        local new_value=$((current_dec | (1 << bit)))
    else
        error "Direction must be 'input' or 'output'"
        return 1
    fi

    local new_hex=$(printf "0x%02x" $new_value)

    if i2c_write $reg $new_hex; then
        success "Pin $pin set as $direction"
        return 0
    else
        return 1
    fi
}

# Set pin output value (only for output pins)
set_pin_output() {
    local pin=$1
    local value=$2  # 0 or 1

    if [[ -z "$pin" || -z "$value" ]]; then
        error "Usage: set_pin_output <pin_number> <0|1>"
        return 1
    fi

    if [[ $pin -lt 0 || $pin -gt 47 ]]; then
        error "Pin number must be between 0 and 47"
        return 1
    fi

    if [[ $value -ne 0 && $value -ne 1 ]]; then
        error "Value must be 0 or 1"
        return 1
    fi

    local port=$((pin / 8))
    local bit=$((pin % 8))
    local reg=${REGISTERS["OUTPUT_PORT$port"]}

    # Read current output
    local current=$(i2c_read $reg)
    if [[ $? -ne 0 ]]; then
        return 1
    fi

    local current_dec=$((current))

    if [[ $value -eq 1 ]]; then
        # Set bit
        local new_value=$((current_dec | (1 << bit)))
    else
        # Clear bit
        local new_value=$((current_dec & ~(1 << bit)))
    fi

    local new_hex=$(printf "0x%02x" $new_value)

    if i2c_write $reg $new_hex; then
        success "Pin $pin output set to $value"
        return 0
    else
        return 1
    fi
}

# Read pin input value
read_pin_input() {
    local pin=$1

    if [[ -z "$pin" ]]; then
        error "Usage: read_pin_input <pin_number>"
        return 1
    fi

    if [[ $pin -lt 0 || $pin -gt 47 ]]; then
        error "Pin number must be between 0 and 47"
        return 1
    fi

    local port=$((pin / 8))
    local bit=$((pin % 8))
    local reg=${REGISTERS["INPUT_PORT$port"]}

    # Read input register
    local current=$(i2c_read $reg)
    if [[ $? -ne 0 ]]; then
        return 1
    fi

    local current_dec=$((current))
    local pin_value=$(((current_dec >> bit) & 1))

    echo $pin_value
    return 0
}

# Set pull-up/pull-down resistor
set_pin_pull() {
    local pin=$1
    local pull=$2  # "up", "down", or "none"

    if [[ -z "$pin" || -z "$pull" ]]; then
        error "Usage: set_pin_pull <pin_number> <up|down|none>"
        return 1
    fi

    if [[ $pin -lt 0 || $pin -gt 47 ]]; then
        error "Pin number must be between 0 and 47"
        return 1
    fi

    local port=$((pin / 8))
    local bit=$((pin % 8))
    local enable_reg=${REGISTERS["PULL_ENABLE$port"]}
    local select_reg=${REGISTERS["PULL_SELECT$port"]}

    if [[ "$pull" == "none" ]]; then
        # Disable pull resistor
        local current=$(i2c_read $enable_reg)
        if [[ $? -ne 0 ]]; then return 1; fi
        local current_dec=$((current))
        local new_value=$((current_dec & ~(1 << bit)))
        local new_hex=$(printf "0x%02x" $new_value)
        i2c_write $enable_reg $new_hex
    else
        # Enable pull resistor
        local current=$(i2c_read $enable_reg)
        if [[ $? -ne 0 ]]; then return 1; fi
        local current_dec=$((current))
        local new_enable=$((current_dec | (1 << bit)))
        local new_enable_hex=$(printf "0x%02x" $new_enable)

        # Set pull direction
        current=$(i2c_read $select_reg)
        if [[ $? -ne 0 ]]; then return 1; fi
        current_dec=$((current))

        if [[ "$pull" == "up" ]]; then
            local new_select=$((current_dec | (1 << bit)))
        elif [[ "$pull" == "down" ]]; then
            local new_select=$((current_dec & ~(1 << bit)))
        else
            error "Pull must be 'up', 'down', or 'none'"
            return 1
        fi

        local new_select_hex=$(printf "0x%02x" $new_select)

        if i2c_write $enable_reg $new_enable_hex && i2c_write $select_reg $new_select_hex; then
            success "Pin $pin pull resistor set to $pull"
            return 0
        else
            return 1
        fi
    fi
}

# Read all input ports
read_all_inputs() {
    log "Reading all input ports:"
    for i in {0..5}; do
        local reg=${REGISTERS["INPUT_PORT$i"]}
        local value=$(i2c_read $reg)
        if [[ $? -eq 0 ]]; then
            printf "Port %d (pins %2d-%2d): %s (0b" $i $((i*8)) $((i*8+7)) $value
            # Convert hex to binary
            local dec_val=$((value))
            for bit in {7..0}; do
                printf "%d" $(((dec_val >> bit) & 1))
            done
            printf ")\n"
        fi
    done
}

# Get the GPIO chip device for Pi 5 compatibility
get_gpio_chip() {
    # Pi 5 uses gpiochip4, older models use gpiochip0
    if [ -c "/dev/gpiochip4" ]; then
        echo "/dev/gpiochip4"  # Pi 5
    elif [ -c "/dev/gpiochip0" ]; then
        echo "/dev/gpiochip0"  # Pi 4 and older
    else
        echo ""
    fi
}

# Configure the GPIO pin connected to the RESET pin
set_reset_pin() {
    local pin=$1

    if [[ -z "$pin" ]]; then
        error "Usage: set_reset_pin <gpio_pin>"
        return 1
    fi

    # Validate GPIO pin number (BCM numbering)
    # Pi 5 has GPIO 0-27, but some pins may not be available
    if [[ ! $pin =~ ^[0-9]+$ ]] || [[ $pin -lt 0 ]] || [[ $pin -gt 27 ]]; then
        error "Invalid GPIO pin number. Must be between 0 and 27 (BCM numbering)"
        return 1
    fi

    RESET_PIN="$pin"
    success "Reset pin set to GPIO $RESET_PIN (BCM numbering)"

    # Configure the pin using the best available method
    if command -v gpioset >/dev/null 2>&1; then
        # Using libgpiod (recommended for Pi 5)
        local gpio_chip=$(get_gpio_chip)
        if [[ -n "$gpio_chip" ]]; then
            log "Using libgpiod with $gpio_chip"
            # Set pin high initially (reset inactive)
            if gpioset "$gpio_chip" "$RESET_PIN=1"; then
                log "Reset pin configured as output and set HIGH via libgpiod"
            else
                warning "Failed to configure reset pin via libgpiod. You may need to run with sudo"
            fi
        else
            warning "No GPIO chip device found"
        fi
    elif command -v gpio >/dev/null 2>&1; then
        # Using WiringPi (deprecated, may not work on Pi 5)
        warning "Using deprecated WiringPi - may not work on Pi 5"
        if gpio -g mode $RESET_PIN out && gpio -g write $RESET_PIN 1; then
            log "Reset pin configured as output and set HIGH via WiringPi"
        else
            warning "Failed to configure reset pin via WiringPi. You may need to run with sudo"
        fi
    elif [ -d "/sys/class/gpio" ]; then
        # Using sysfs GPIO interface (fallback)
        log "Using sysfs interface for GPIO configuration"

        # Export the GPIO if not already exported
        if [ ! -d "/sys/class/gpio/gpio$RESET_PIN" ]; then
            echo "$RESET_PIN" > /sys/class/gpio/export 2>/dev/null || {
                warning "Failed to export GPIO $RESET_PIN. You may need to run with sudo"
                return 1
            }
            # Give the system time to create the GPIO directory
            sleep 0.1
        fi

        # Set direction to output
        echo "out" > "/sys/class/gpio/gpio$RESET_PIN/direction" 2>/dev/null || {
            warning "Failed to set GPIO $RESET_PIN direction. You may need to run with sudo"
            return 1
        }

        # Set value to HIGH (1)
        echo "1" > "/sys/class/gpio/gpio$RESET_PIN/value" 2>/dev/null || {
            warning "Failed to set GPIO $RESET_PIN value. You may need to run with sudo"
            return 1
        }

        success "Reset pin configured via sysfs"
    else
        warning "No GPIO control method available."
        warning "For Pi 5, install: sudo apt-get install gpiod"
        warning "Reset functionality will be limited to software reset only"
    fi

    return 0
}

# Reset the chip (hardware or software)
reset_chip() {
    local mode=${1:-"hard"}

    if [[ "$mode" != "hard" && "$mode" != "soft" ]]; then
        error "Reset mode must be 'hard' or 'soft'"
        return 1
    fi

    log "Performing $mode reset of PI4IOE5V96248..."

    if [[ "$mode" == "hard" ]]; then
        # Hardware reset using the RESET pin
        log "Toggling hardware RESET pin (GPIO $RESET_PIN)"

        if command -v gpioset >/dev/null 2>&1; then
            # Using libgpiod (recommended for Pi 5)
            local gpio_chip=$(get_gpio_chip)
            if [[ -n "$gpio_chip" ]]; then
                log "Using libgpiod for hardware reset"
                # Pull reset pin low, wait, then high
                if gpioset "$gpio_chip" "$RESET_PIN=0"; then
                    sleep 0.01  # 10ms pulse
                    gpioset "$gpio_chip" "$RESET_PIN=1"
                    success "Hardware reset completed via libgpiod"
                else
                    error "Failed to toggle reset pin via libgpiod. You may need to run with sudo"
                    return 1
                fi
            else
                warning "No GPIO chip device found for libgpiod"
                warning "Falling back to software reset"
                mode="soft"
            fi
        elif command -v gpio >/dev/null 2>&1; then
            # Using WiringPi (may not work on Pi 5)
            warning "Using deprecated WiringPi for reset"
            if gpio -g write $RESET_PIN 0; then
                sleep 0.01  # 10ms pulse
                gpio -g write $RESET_PIN 1
                success "Hardware reset completed via WiringPi"
            else
                error "Failed to toggle reset pin via WiringPi. You may need to run with sudo"
                return 1
            fi
        elif [ -d "/sys/class/gpio/gpio$RESET_PIN" ]; then
            # Using sysfs GPIO interface
            log "Using sysfs for hardware reset"
            if echo "0" > "/sys/class/gpio/gpio$RESET_PIN/value" 2>/dev/null; then
                sleep 0.01  # 10ms pulse
                echo "1" > "/sys/class/gpio/gpio$RESET_PIN/value" 2>/dev/null
                success "Hardware reset completed via sysfs"
            else
                error "Failed to toggle reset pin via sysfs. You may need to run with sudo"
                return 1
            fi
        else
            warning "Cannot perform hardware reset: GPIO control not available"
            warning "Falling back to software reset"
            mode="soft"
        fi
    fi

    if [[ "$mode" == "soft" ]]; then
        # Software reset by reinitializing all registers
        log "Performing software reset by reinitializing registers"

        # Detect the chip address first
        if detect_chip; then
            # Set all pins as inputs (CONFIG registers: 1=input)
            for i in {0..5}; do
                i2c_write ${REGISTERS["CONFIG$i"]} 0xFF
            done

            # Clear output registers
            for i in {0..5}; do
                i2c_write ${REGISTERS["OUTPUT_PORT$i"]} 0x00
            done

            # Clear polarity inversion
            for i in {0..5}; do
                i2c_write ${REGISTERS["POLARITY_INV$i"]} 0x00
            done

            # Reset pull-up/down configuration
            for i in {0..5}; do
                i2c_write ${REGISTERS["PULL_ENABLE$i"]} 0x00
                i2c_write ${REGISTERS["PULL_SELECT$i"]} 0x00
            done

            # Reset interrupt configuration
            for i in {0..5}; do
                i2c_write ${REGISTERS["INT_MASK$i"]} 0x00
            done

            success "Software reset completed"
        else
            error "Software reset failed: Could not communicate with the chip"
            return 1
        fi
    fi

    return 0
}

# Display chip status
show_status() {
    log "PI4IOE5V96248 Status:"
    echo "I2C Bus: $I2C_BUS"
    echo "I2C Address: $I2C_ADDR"
    echo "Reset Pin (BCM): $RESET_PIN"
    echo ""

    echo "Configuration (1=input, 0=output):"
    for i in {0..5}; do
        local reg=${REGISTERS["CONFIG$i"]}
        local value=$(i2c_read $reg)
        if [[ $? -eq 0 ]]; then
            printf "Port %d: %s\n" $i $value
        fi
    done
    echo ""

    read_all_inputs
}

# Help function
show_help() {
    echo "PI4IOE5V96248 I2C GPIO Expander Control Script"
    echo ""
    echo "Usage: $0 <command> [arguments]"
    echo ""
    echo "Commands:"
    echo "  init                           Initialize the chip"
    echo "  detect                         Detect chip on I2C bus"
    echo "  status                         Show chip status"
    echo "  set-direction <pin> <dir>      Set pin direction (input/output)"
    echo "  set-output <pin> <value>       Set output pin value (0/1)"
    echo "  read-input <pin>               Read input pin value"
    echo "  read-all                       Read all input ports"
    echo "  set-pull <pin> <pull>          Set pull resistor (up/down/none)"
    echo "  reset [hard|soft]              Reset the chip (hardware or software)"
    echo "  set-reset-pin <gpio_pin>       Configure the GPIO pin connected to RESET"
    echo "  help                           Show this help"
    echo ""
    echo "Examples:"
    echo "  $0 init"
    echo "  $0 set-direction 0 output"
    echo "  $0 set-output 0 1"
    echo "  $0 read-input 5"
    echo "  $0 set-pull 10 up"
    echo "  $0 reset hard"
    echo "  $0 set-reset-pin 27"
    echo ""
    echo "Pin numbers range from 0 to 47 (6 ports × 8 pins each)"
    echo "Reset pin uses BCM GPIO numbering"
    echo ""
    echo "Pi 5 Setup:"
    echo "  sudo apt-get update"
    echo "  sudo apt-get install i2c-tools gpiod"
    echo "  Enable I2C: sudo raspi-config -> Interface Options -> I2C"
}

# Main script logic
main() {
    if [[ $# -eq 0 ]]; then
        show_help
        exit 1
    fi

    # Check if running on Raspberry Pi (skip for help command)
    if [[ "$1" != "help" ]]; then
        if ! check_raspberry_pi; then
            exit 1
        fi

        if ! check_i2c_setup; then
            exit 1
        fi
    fi

    case "$1" in
        "init")
            detect_chip && init_chip
            ;;
        "detect")
            detect_chip
            ;;
        "status")
            detect_chip && show_status
            ;;
        "set-direction")
            if [[ $# -ne 3 ]]; then
                error "Usage: $0 set-direction <pin> <input|output>"
                exit 1
            fi
            detect_chip && set_pin_direction "$2" "$3"
            ;;
        "set-output")
            if [[ $# -ne 3 ]]; then
                error "Usage: $0 set-output <pin> <0|1>"
                exit 1
            fi
            detect_chip && set_pin_output "$2" "$3"
            ;;
        "read-input")
            if [[ $# -ne 2 ]]; then
                error "Usage: $0 read-input <pin>"
                exit 1
            fi
            detect_chip && read_pin_input "$2"
            ;;
        "read-all")
            detect_chip && read_all_inputs
            ;;
        "set-pull")
            if [[ $# -ne 3 ]]; then
                error "Usage: $0 set-pull <pin> <up|down|none>"
                exit 1
            fi
            detect_chip && set_pin_pull "$2" "$3"
            ;;
        "reset")
            local mode="hard"
            if [[ $# -eq 2 ]]; then
                mode="$2"
            fi
            reset_chip "$mode"
            ;;
        "set-reset-pin")
            if [[ $# -ne 2 ]]; then
                error "Usage: $0 set-reset-pin <gpio_pin>"
                exit 1
            fi
            set_reset_pin "$2"
            ;;
        "help")
            show_help
            ;;
        *)
            error "Unknown command: $1"
            show_help
            exit 1
            ;;
    esac
}

# Run main function with all arguments
main "$@"
