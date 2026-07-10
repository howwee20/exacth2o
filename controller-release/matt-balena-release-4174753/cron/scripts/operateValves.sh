#!/bin/bash

# Script to operate all valves (1-48) on a specified relay board
# Usage: ./operateValves.sh [RELAY_ADDRESS] [STATE]
# Examples:
#   ./operateValves.sh 0x20 OPEN
#   ./operateValves.sh 0x21 CLOSE
#   ./operateValves.sh OPEN        (uses default relay 0x20)
#   ./operateValves.sh             (uses default relay 0x20 and state OPEN)

# Function to show usage
show_usage() {
    echo "Usage: $0 [RELAY_ADDRESS] [STATE]"
    echo "  RELAY_ADDRESS: Hex address of the relay board (default: 0x20)"
    echo "  STATE: OPEN or CLOSE (default: OPEN)"
    echo ""
    echo "Examples:"
    echo "  $0 0x20 OPEN     # Open all valves on relay 0x20"
    echo "  $0 0x21 CLOSE    # Close all valves on relay 0x21"
    echo "  $0 OPEN          # Open all valves on default relay 0x20"
    echo "  $0               # Open all valves on default relay 0x20"
    exit 1
}

# Parse arguments
if [ $# -eq 0 ]; then
    # No arguments - use defaults
    RELAY_ADDRESS="0x20"
    STATE="OPEN"
elif [ $# -eq 1 ]; then
    # One argument - could be relay address or state
    if [[ "$1" =~ ^0x[0-9a-fA-F]+$ ]]; then
        # First argument is a hex address
        RELAY_ADDRESS="$1"
        STATE="OPEN"
    elif [[ "$1" == "OPEN" || "$1" == "CLOSE" ]]; then
        # First argument is a state
        RELAY_ADDRESS="0x20"
        STATE="$1"
    else
        echo "Error: Invalid argument '$1'"
        show_usage
    fi
elif [ $# -eq 2 ]; then
    # Two arguments - relay address and state
    RELAY_ADDRESS="$1"
    STATE="$2"
else
    echo "Error: Too many arguments"
    show_usage
fi

# Validate relay address format
if [[ ! "$RELAY_ADDRESS" =~ ^0x[0-9a-fA-F]+$ ]]; then
    echo "Error: Invalid relay address '$RELAY_ADDRESS'. Must be in hex format (e.g., 0x20)"
    exit 1
fi

# Validate state parameter
if [[ "$STATE" != "OPEN" && "$STATE" != "CLOSE" ]]; then
    echo "Error: Invalid state '$STATE'. Use 'OPEN' or 'CLOSE'"
    exit 1
fi

echo "Operating all valves (1-48) on relay $RELAY_ADDRESS with state: $STATE"
echo "Starting valve operations..."

# Loop through all 48 valve addresses
for i in {1..48}; do
    echo "Processing valve $i on relay $RELAY_ADDRESS..."

    curl --location 'http://127.0.0.1:3000/v1/valves' \
        --header 'Content-Type: application/json' \
        --data "{
            \"relayAddress\": \"$RELAY_ADDRESS\",
            \"address\": $i,
            \"state\": \"$STATE\"
        }" \
        --silent

    echo ""  # Add blank line for readability
done

echo "All valve operations completed!"
