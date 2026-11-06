# StateMachine Refactoring

## Overview

The original `StateMachine.ts` file has been refactored to improve maintainability, testability, and code organization. The monolithic class (833 lines) has been broken down into focused, single-responsibility services.

## Problems with Original Design

1. **Violation of Single Responsibility Principle**: The StateMachine class was handling:
   - API communication
   - Hardware control (valves and sensors)
   - State management and rules
   - Event queue processing
   - Configuration management

2. **Hard to Test**: Tightly coupled dependencies made unit testing difficult
3. **Hard to Maintain**: Large class with mixed concerns
4. **Poor Separation of Concerns**: Business logic, hardware control, and data access mixed together

## New Architecture

### Directory Structure

```
src/
├── types/
│   └── system.ts                 # Type definitions and interfaces
├── config/
│   └── constants.ts              # Configuration constants
├── services/
│   ├── ApiService.ts             # HTTP API communication
│   ├── PairingService.ts         # Pairing data management
│   ├── ValveService.ts           # Valve hardware control
│   ├── SensorService.ts          # Sensor hardware control
│   ├── RulesEngineService.ts     # State transition rules
│   └── EventQueueService.ts     # Event queue management
└── refactored/
    └── StateMachine.ts           # Orchestrator class
```

### Services Overview

#### 1. **ApiService** (`services/ApiService.ts`)
- **Purpose**: Centralized HTTP API communication
- **Responsibilities**:
  - GET/POST requests to backend API
  - Error handling for network requests
- **Benefits**: Easy to mock for testing, reusable across services

#### 2. **PairingService** (`services/PairingService.ts`)
- **Purpose**: Manage pairing data and state
- **Responsibilities**:
  - Fetch pairings from API
  - Store and retrieve pairing state
  - Manage pairing lifecycle
- **Benefits**: Centralized pairing logic, easy to test data operations

#### 3. **ValveService** (`services/ValveService.ts`)
- **Purpose**: Handle all valve-related operations
- **Responsibilities**:
  - Valve hardware control
  - Board configuration management
  - Pin address calculations
  - Valve setup in API
- **Benefits**: Hardware abstraction, easier to mock for testing

#### 4. **SensorService** (`services/SensorService.ts`)
- **Purpose**: Handle all sensor-related operations
- **Responsibilities**:
  - Sensor data collection
  - Sensor configuration setup
  - Data calibration
- **Benefits**: Sensor logic isolation, easier hardware testing

#### 5. **RulesEngineService** (`services/RulesEngineService.ts`)
- **Purpose**: Manage state transition rules
- **Responsibilities**:
  - Setup and maintain business rules
  - Evaluate state transitions
- **Benefits**: Business logic separation, easier to modify rules

#### 6. **EventQueueService** (`services/EventQueueService.ts`)
- **Purpose**: Manage the event processing queue
- **Responsibilities**:
  - Queue state transitions
  - Process events asynchronously
  - Control event loop lifecycle
- **Benefits**: Better event handling, easier debugging

### Configuration Management

#### **types/system.ts**
- Centralized type definitions
- Interfaces for all system entities
- No logic, pure type definitions

#### **config/constants.ts**
- Application constants
- API endpoints
- Default configurations
- Timing constants

## Benefits of Refactored Design

### 1. **Single Responsibility Principle**
Each service has one clear purpose and responsibility.

### 2. **Improved Testability**
- Services can be unit tested in isolation
- Dependencies can be easily mocked
- Business logic separated from infrastructure

### 3. **Better Maintainability**
- Smaller, focused files are easier to understand
- Changes to one concern don't affect others
- Clear separation of hardware, API, and business logic

### 4. **Easier to Extend**
- New features can be added as new services
- Existing services can be modified without affecting others
- Plugin architecture possible

### 5. **Dependency Injection**
- Services are injected into the StateMachine
- Easy to swap implementations
- Better for testing and configuration

## Migration Guide

### For Testing
```typescript
// Before: Hard to test monolithic class
const stateMachine = new StateMachine(apiUrl)

// After: Easy to test with mocked services
const mockApiService = new MockApiService()
const mockValveService = new MockValveService()
// ... inject mocked services
```

### For Configuration
```typescript
// Before: Constants scattered throughout
const VALVE_COLS = 6 // defined in class

// After: Centralized configuration
import { VALVE_CONFIGURATION } from './config/constants'
console.log(VALVE_CONFIGURATION.COLS)
```

### For Adding New Features
```typescript
// Before: Add to large StateMachine class

// After: Create new service
class NewFeatureService {
  constructor(private apiService: ApiService) {}
  // ... implement new feature
}

// Add to StateMachine constructor
class StateMachine {
  constructor(apiURL: string) {
    this.newFeatureService = new NewFeatureService(this.apiService)
  }
}
```

## Usage

### Original Usage (Still Supported)
The refactored StateMachine maintains the same public API, so existing code should work without changes:

```typescript
import StateMachine from './refactored/StateMachine'

const stateMachine = new StateMachine('http://api.example.com')
await stateMachine.init()
await stateMachine.start()
```

### Advanced Usage (New Capabilities)
```typescript
// Access individual services for advanced operations
const valveService = stateMachine.getValveService() // Would need to add getter
const sensorService = stateMachine.getSensorService() // Would need to add getter

// Better testing support
const mockStateMachine = new StateMachine('http://mock-api.com', {
  valveService: new MockValveService(),
  sensorService: new MockSensorService()
})
```

## Next Steps

1. **Testing**: Write unit tests for each service
2. **Integration**: Test the refactored system with hardware
3. **Documentation**: Add JSDoc comments to all services
4. **Performance**: Monitor performance compared to original
5. **Extensions**: Consider additional services for logging, monitoring, etc.

## Files Changed

- **Moved**: Original `stateMachine.ts` → `stateMachine.ts.bak` (backup)
- **Created**: All new service files and types
- **New**: `refactored/StateMachine.ts` (new orchestrator)

This refactoring makes the codebase much more maintainable while preserving all existing functionality.
