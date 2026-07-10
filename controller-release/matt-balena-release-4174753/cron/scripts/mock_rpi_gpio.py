"""
Mock RPi.GPIO module for development on non-Raspberry Pi systems
This provides the same interface as RPi.GPIO but without actual hardware interaction
"""

# GPIO modes
BOARD = 10
BCM = 11

# GPIO states
LOW = 0
HIGH = 1

# GPIO setup modes
IN = 1
OUT = 0

# Pull up/down resistors
PUD_OFF = 0
PUD_DOWN = 1
PUD_UP = 2

# Edge detection
RISING = 1
FALLING = 2
BOTH = 3

_mode = None
_warnings = True
_setup_pins = {}

def setmode(mode):
    """Set the GPIO mode (BOARD or BCM)"""
    global _mode
    _mode = mode
    print(f"Mock GPIO: Set mode to {'BOARD' if mode == BOARD else 'BCM'}")

def setwarnings(flag):
    """Enable or disable warnings"""
    global _warnings
    _warnings = flag
    print(f"Mock GPIO: Warnings {'enabled' if flag else 'disabled'}")

def setup(channel, direction, initial=None, pull_up_down=PUD_OFF):
    """Setup a GPIO pin"""
    global _setup_pins
    _setup_pins[channel] = {'direction': direction, 'state': initial or LOW}
    dir_str = 'IN' if direction == IN else 'OUT'
    print(f"Mock GPIO: Setup pin {channel} as {dir_str}")
    if initial is not None:
        print(f"Mock GPIO: Set initial state of pin {channel} to {'HIGH' if initial else 'LOW'}")

def output(channel, state):
    """Set the output state of a GPIO pin"""
    if channel in _setup_pins:
        _setup_pins[channel]['state'] = state
        print(f"Mock GPIO: Set pin {channel} to {'HIGH' if state else 'LOW'}")
    else:
        print(f"Mock GPIO: Warning - pin {channel} not setup")

def input(channel):
    """Read the input state of a GPIO pin"""
    if channel in _setup_pins:
        state = _setup_pins[channel]['state']
        print(f"Mock GPIO: Read pin {channel} as {'HIGH' if state else 'LOW'}")
        return state
    else:
        print(f"Mock GPIO: Warning - pin {channel} not setup")
        return LOW

def cleanup(channel=None):
    """Clean up GPIO resources"""
    if channel is None:
        print("Mock GPIO: Cleanup all pins")
        _setup_pins.clear()
    else:
        if channel in _setup_pins:
            del _setup_pins[channel]
            print(f"Mock GPIO: Cleanup pin {channel}")

def add_event_detect(channel, edge, callback=None, bouncetime=None):
    """Add edge detection for a GPIO pin"""
    print(f"Mock GPIO: Add event detect on pin {channel}")

def remove_event_detect(channel):
    """Remove edge detection for a GPIO pin"""
    print(f"Mock GPIO: Remove event detect on pin {channel}")

def wait_for_edge(channel, edge, timeout=None):
    """Wait for an edge on a GPIO pin"""
    print(f"Mock GPIO: Wait for edge on pin {channel}")
    return channel

def gpio_function(channel):
    """Get the function of a GPIO pin"""
    if channel in _setup_pins:
        return _setup_pins[channel]['direction']
    return IN

class PWM:
    """Mock PWM class"""
    def __init__(self, channel, frequency):
        self.channel = channel
        self.frequency = frequency
        self.duty_cycle = 0
        self.started = False
        print(f"Mock GPIO: PWM created on pin {channel} with frequency {frequency}Hz")

    def start(self, duty_cycle):
        """Start PWM"""
        self.duty_cycle = duty_cycle
        self.started = True
        print(f"Mock GPIO: PWM started on pin {self.channel} with duty cycle {duty_cycle}%")

    def stop(self):
        """Stop PWM"""
        self.started = False
        print(f"Mock GPIO: PWM stopped on pin {self.channel}")

    def ChangeDutyCycle(self, duty_cycle):
        """Change PWM duty cycle"""
        self.duty_cycle = duty_cycle
        print(f"Mock GPIO: PWM duty cycle changed to {duty_cycle}% on pin {self.channel}")

    def ChangeFrequency(self, frequency):
        """Change PWM frequency"""
        self.frequency = frequency
        print(f"Mock GPIO: PWM frequency changed to {frequency}Hz on pin {self.channel}")

# Version info
VERSION = "0.7.1"
