# StateMachine State Transition Rules - Visual Guide

## 🎯 Core State Machine Logic

The irrigation system operates on a finite state machine with these states:

### State Definitions

| State | Purpose | Duration | Next State Condition |
|-------|---------|----------|---------------------|
| **STARTUP** | Initialize pairing | Immediate | Always → MEASURING |
| **MEASURING** | Read soil moisture | `measurementTime` | Timer → DELAY |
| **DELAY** | Process reading | `delayTime` | Timer + Condition → VALVE_OPEN/CLOSE |
| **VALVE_OPEN** | Irrigate soil | `valveOpenTime` | Timer → VALVE_CLOSE |
| **VALVE_CLOSE** | Stop irrigation | `standardValveCloseTime` | Timer → IDLE |
| **IDLE** | Wait for next cycle | `intervalTime` | Timer → MEASURING |
| **DISABLED** | Pairing stopped | Indefinite | Manual → [*] |

## 🔄 State Transition Logic (from RulesEngineService)

### Rule 1: STARTUP → MEASURING
```typescript
// Always transition immediately from startup
if (state === 'STARTUP') {
  nextState = 'MEASURING'
}
```

### Rule 2: MEASURING → DELAY
```typescript
// After measurement time expires
if (state === 'MEASURING' && currentTime >= nextTransitionTime) {
  nextState = 'DELAY'
}
```

### Rule 3: DELAY → VALVE_OPEN
```typescript
// If soil is too dry (below moisture limit)
if (state === 'DELAY' &&
    currentTime >= nextTransitionTime &&
    WTCPercentMeasured < WTCPercentLimit) {
  nextState = 'VALVE_OPEN'
}
```

### Rule 4: DELAY → VALVE_CLOSE
```typescript
// If soil has sufficient moisture (at or above limit)
if (state === 'DELAY' &&
    currentTime >= nextTransitionTime &&
    WTCPercentMeasured >= WTCPercentLimit) {
  nextState = 'VALVE_CLOSE'
}
```

### Rule 5: VALVE_OPEN → VALVE_CLOSE
```typescript
// After valve has been open for specified duration
if (state === 'VALVE_OPEN' && currentTime >= nextTransitionTime) {
  nextState = 'VALVE_CLOSE'
}
```

### Rule 6: VALVE_CLOSE → IDLE
```typescript
// After valve close operation completes
if (state === 'VALVE_CLOSE' && currentTime >= nextTransitionTime) {
  nextState = 'IDLE'
}
```

### Rule 7: IDLE → MEASURING
```typescript
// After waiting for the measurement interval
if (state === 'IDLE' && currentTime >= nextTransitionTime) {
  nextState = 'MEASURING'
}
```

### Rule 8: Any State → DISABLED
```typescript
// Manual disable command (handled outside rules engine)
if (disableCommand) {
  nextState = 'DISABLED'
}
```

## 📊 Decision Tree for DELAY State

```
DELAY State
    |
    ├─ Timer Expired?
    │   ├─ NO → Stay in DELAY
    │   └─ YES → Check Moisture Level
    │            |
    │            ├─ WTC < Limit? (Soil too dry)
    │            │   └─ YES → VALVE_OPEN (Start irrigation)
    │            │
    │            └─ WTC >= Limit? (Soil has enough moisture)
    │                └─ YES → VALVE_CLOSE (Skip irrigation)
```

## ⏱️ Timing Examples

### Example Pairing Configuration:
```typescript
const timingRules: TimingSet = {
  startDelayTime: 1000,      // 1 second initial delay
  measurementTime: 5000,     // 5 seconds to read sensor
  delayTime: 2000,          // 2 seconds to process
  valveOpenTime: 30000,     // 30 seconds irrigation
  intervalTime: 3600000     // 1 hour between cycles
}

const WTCPercentLimit = 30  // 30% moisture threshold
```

### Timeline Example (Dry Soil Scenario):
```
T=0s      STARTUP → MEASURING
T=0s      Start sensor reading
T=5s      MEASURING → DELAY (measurement complete)
T=7s      DELAY → VALVE_OPEN (soil = 20% < 30% limit)
T=37s     VALVE_OPEN → VALVE_CLOSE (irrigation complete)
T=38s     VALVE_CLOSE → IDLE (valve closed)
T=3638s   IDLE → MEASURING (next cycle starts)
```

### Timeline Example (Moist Soil Scenario):
```
T=0s      STARTUP → MEASURING
T=0s      Start sensor reading
T=5s      MEASURING → DELAY (measurement complete)
T=7s      DELAY → VALVE_CLOSE (soil = 35% >= 30% limit)
T=8s      VALVE_CLOSE → IDLE (no irrigation needed)
T=3608s   IDLE → MEASURING (next cycle starts)
```

## 🎮 Facts Used by Rules Engine

The rules engine evaluates these facts for each pairing:

```typescript
const facts = {
  state: 'DELAY',                    // Current state
  measurementTime: 5000,             // Time to complete measurement
  delayTime: 2000,                   // Processing delay time
  valveOpenTime: 30000,              // Irrigation duration
  intervalTime: 3600000,             // Time between cycles
  nextTransitionTime: 1642678950000, // When next transition should occur
  WTCPercentLimit: 30,               // Moisture threshold (%)
  WTCPercentMeasured: 25,            // Current measured moisture (%)
  currentTime: 1642678952000         // Current timestamp
}
```

## 🚦 State Machine Validation

### Valid State Transitions:
- ✅ STARTUP → MEASURING
- ✅ MEASURING → DELAY
- ✅ DELAY → VALVE_OPEN
- ✅ DELAY → VALVE_CLOSE
- ✅ VALVE_OPEN → VALVE_CLOSE
- ✅ VALVE_CLOSE → IDLE
- ✅ IDLE → MEASURING
- ✅ Any State → DISABLED

### Invalid State Transitions:
- ❌ MEASURING → VALVE_OPEN (must go through DELAY)
- ❌ VALVE_OPEN → IDLE (must go through VALVE_CLOSE)
- ❌ IDLE → DELAY (must go through MEASURING)
- ❌ DISABLED → Any State (terminal state)

## 🔧 Implementation Notes

### RulesEngineService Structure:
1. **Constructor**: Initializes json-rules-engine and sets up all rules
2. **setupRules()**: Defines the 8 state transition rules
3. **evaluateRules(facts)**: Runs facts through engine, returns matching events
4. **getEngine()**: Provides access to underlying engine for advanced usage

### Event Processing:
1. StateMachine queues a state transition event
2. EventQueueService processes the event
3. StateMachine calls RulesEngineService.evaluateRules()
4. Rules engine returns matching transition events
5. StateMachine executes the appropriate action for new state
6. Process repeats with new state

This rule-based approach makes the state machine logic:
- **Declarative**: Rules clearly state conditions and outcomes
- **Maintainable**: Easy to modify business logic by changing rules
- **Testable**: Rules can be tested independently with different fact combinations
- **Auditable**: Clear visibility into decision-making process
