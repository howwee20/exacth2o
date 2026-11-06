# StateMachine API Documentation

## 🚀 Quick Start

```typescript
import StateMachine from './refactored/StateMachine'

// Initialize the state machine
const stateMachine = new StateMachine('http://your-api-url.com')

// Initialize hardware and configurations
await stateMachine.init(true) // true = initialize hardware

// Start processing pairings
await stateMachine.start()
```

## 📘 Class: StateMachine

### Constructor

```typescript
constructor(apiURL: string, standardDelayTime?: number)
```

**Parameters:**
- `apiURL` (string): Base URL for the backend API
- `standardDelayTime` (number, optional): Default delay time in milliseconds (default: 1000)

**Example:**
```typescript
const stateMachine = new StateMachine('http://localhost:3000', 2000)
```

---

## 🎯 Core Methods

### `async init(initializeHardware?: boolean): Promise<void>`

Initializes the state machine and optionally sets up hardware.

**Parameters:**
- `initializeHardware` (boolean, optional): Whether to initialize hardware components (default: true)

**What it does:**
- Sets up valve board configurations
- Initializes sensor and valve hardware (if requested)
- Fetches pairing configurations from API
- Prepares the rules engine

**Example:**
```typescript
// Full initialization with hardware setup
await stateMachine.init(true)

// Software-only initialization (useful for testing)
await stateMachine.init(false)
```

---

### `async start(): Promise<void>`

Starts the state machine and begins processing all configured pairings.

**What it does:**
- Fetches latest pairing configurations
- Activates all pairings in IDLE state
- Starts the event processing loop

**Example:**
```typescript
await stateMachine.start()
console.log('StateMachine is now running!')
```

---

### `startPairing(sensorId: number, valveId: number, state?: PairingStateType, nextTransitionTime?: number): void`

Activates a specific sensor-valve pairing.

**Parameters:**
- `sensorId` (number): ID of the sensor
- `valveId` (number): ID of the valve
- `state` (PairingStateType, optional): Initial state (default: 'IDLE')
- `nextTransitionTime` (number, optional): When to start processing (default: now)

**Example:**
```typescript
// Start pairing immediately in IDLE state
stateMachine.startPairing(1, 5)

// Start pairing in MEASURING state after 5 seconds
stateMachine.startPairing(2, 7, 'MEASURING', Date.now() + 5000)
```

---

### `async setState(state: MachineState): Promise<void>`

Changes the overall state machine state.

**Parameters:**
- `state` (MachineState): Target state

**MachineState Options:**
- `STARTUP`: Initialize and start
- `RUNNING`: Resume operation
- `STOPPED`: Stop all processing
- `UPDATE`: Restart with new configuration
- `RESET`: Full reinitialization

**Example:**
```typescript
// Stop the state machine
await stateMachine.setState(MachineState.STOPPED)

// Reset and reinitialize
await stateMachine.setState(MachineState.RESET)
```

---

## 📊 Query Methods

### `getPairingState(sensorId: string, valveId: string): PairingState | undefined`

Retrieves the current state of a specific pairing.

**Returns:** PairingState object or undefined if not found

**Example:**
```typescript
const pairing = stateMachine.getPairingState('1', '5')
if (pairing) {
  console.log(`Pairing 1-5 is in state: ${pairing.state}`)
  console.log(`Moisture level: ${pairing.WTCPercentMeasured}%`)
  console.log(`Next transition: ${new Date(pairing.nextTransitionTime!)}`)
}
```

---

### `getAllPairingStates(): PairingState[]`

Gets all current pairing states.

**Returns:** Array of all PairingState objects

**Example:**
```typescript
const allPairings = stateMachine.getAllPairingStates()
allPairings.forEach(pairing => {
  console.log(`Pairing ${pairing.sensorId}-${pairing.valveId}: ${pairing.state}`)
})
```

---

### `getState(): MachineState`

Gets the current overall state machine state.

**Returns:** Current MachineState

**Example:**
```typescript
const currentState = stateMachine.getState()
console.log(`StateMachine is ${currentState}`)
```

---

### `pairingsLoaded(): boolean`

Checks if pairing configurations have been loaded from the API.

**Returns:** True if pairings are loaded, false otherwise

**Example:**
```typescript
if (stateMachine.pairingsLoaded()) {
  console.log('Pairings are ready for processing')
} else {
  console.log('Still loading pairing configurations...')
}
```

---

## ⚙️ Configuration Methods

### `setPairingState(sensorId: string, valveId: string, newState: PairingStateType): void`

Manually sets the state of a specific pairing.

**Example:**
```typescript
// Disable a specific pairing
stateMachine.setPairingState('1', '5', 'DISABLED')
```

---

### `disablePairing(sensorId: string, valveId: string): void`

Disables a specific pairing (sets state to DISABLED).

**Example:**
```typescript
stateMachine.disablePairing('1', '5')
```

---

### `getBoardConfigs(): BoardConfig[]`

Gets current valve board configurations.

**Returns:** Array of BoardConfig objects

**Example:**
```typescript
const configs = stateMachine.getBoardConfigs()
configs.forEach(config => {
  console.log(`Board at address 0x${config.address.toString(16)} using reset pin ${config.resetPin}`)
})
```

---

### `async setBoardConfigs(boardConfigs: BoardConfig[], updateAPI?: boolean): Promise<boolean>`

Sets valve board configurations.

**Parameters:**
- `boardConfigs` (BoardConfig[]): Array of board configurations
- `updateAPI` (boolean, optional): Whether to sync with API (default: false)

**Returns:** True if successful, false otherwise

**Example:**
```typescript
const newConfigs = [
  { address: 0x20, resetPin: 17 },
  { address: 0x21, resetPin: 23 }
]

const success = await stateMachine.setBoardConfigs(newConfigs, true)
if (success) {
  console.log('Board configurations updated')
}
```

---

## 🔄 Control Methods

### `runEventLoop(): void`

Starts the event processing loop manually.

**Note:** Usually called automatically by `start()`

**Example:**
```typescript
stateMachine.runEventLoop()
```

---

### `stopEventLoop(): void`

Stops the event processing loop.

**Example:**
```typescript
stateMachine.stopEventLoop()
console.log('Event processing stopped')
```

---

## 📋 Data Types

### PairingState

```typescript
interface PairingState extends IPairing {
  state: 'STARTUP' | 'IDLE' | 'MEASURING' | 'DELAY' | 'VALVE_OPEN' | 'VALVE_CLOSE' | 'DISABLED'
  timingRules: TimingSet
  WTCPercentMeasured: number
  nextTransitionTime: number | null
}
```

### TimingSet

```typescript
interface TimingSet {
  startDelayTime: number      // Initial delay
  measurementTime: number     // Sensor reading time
  delayTime: number          // Processing delay
  valveOpenTime: number      // Irrigation duration
  intervalTime: number       // Time between cycles
}
```

### BoardConfig

```typescript
interface BoardConfig {
  address: number    // I2C address (e.g., 0x20)
  resetPin: number   // GPIO reset pin number
}
```

### MachineState

```typescript
enum MachineState {
  STARTUP = 'STARTUP',
  RUNNING = 'RUNNING',
  STOPPED = 'STOPPED',
  UPDATE = 'UPDATE',
  RESET = 'RESET'
}
```

---

## 🎯 Usage Examples

### Basic Irrigation System

```typescript
import StateMachine from './refactored/StateMachine'

async function setupIrrigationSystem() {
  const stateMachine = new StateMachine('http://api.farm.com')

  try {
    // Initialize with hardware
    await stateMachine.init(true)

    // Start processing
    await stateMachine.start()

    console.log('Irrigation system is running!')

    // Monitor system
    setInterval(() => {
      const pairings = stateMachine.getAllPairingStates()
      pairings.forEach(p => {
        console.log(`Sensor ${p.sensorId} -> Valve ${p.valveId}: ${p.state} (${p.WTCPercentMeasured}%)`)
      })
    }, 10000) // Check every 10 seconds

  } catch (error) {
    console.error('Failed to start irrigation system:', error)
  }
}

setupIrrigationSystem()
```

### Manual Control Example

```typescript
async function manualControl() {
  const stateMachine = new StateMachine('http://api.farm.com')
  await stateMachine.init(false) // No hardware init for testing

  // Manually start specific pairing
  stateMachine.startPairing(1, 1, 'MEASURING')

  // Check status after 5 seconds
  setTimeout(() => {
    const pairing = stateMachine.getPairingState('1', '1')
    console.log(`Pairing status: ${pairing?.state}`)
  }, 5000)

  // Disable pairing after 30 seconds
  setTimeout(() => {
    stateMachine.disablePairing('1', '1')
    console.log('Pairing disabled')
  }, 30000)
}
```

### Error Handling Example

```typescript
async function robustSetup() {
  const stateMachine = new StateMachine('http://api.farm.com')

  try {
    await stateMachine.init(true)
    await stateMachine.start()
  } catch (error) {
    console.error('Initialization failed:', error)

    // Try software-only mode
    try {
      await stateMachine.init(false)
      console.log('Running in software-only mode')
    } catch (fallbackError) {
      console.error('Complete failure:', fallbackError)
      process.exit(1)
    }
  }

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('Shutting down...')
    await stateMachine.setState(MachineState.STOPPED)
    process.exit(0)
  })
}
```

This API provides complete control over the irrigation system while maintaining clean separation of concerns and easy testability.
