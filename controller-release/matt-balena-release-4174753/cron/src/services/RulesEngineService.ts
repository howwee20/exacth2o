import { Engine } from 'json-rules-engine'

/**
 * Service responsible for setting up and managing state machine rules
 */
export class RulesEngineService {
  private engine: Engine

  constructor() {
    this.engine = new Engine()
    this.setupRules()
  }

  private setupRules(): void {
    // Rule to transition from STARTUP to MEASURING
    this.engine.addRule({
      conditions: {
        all: [
          {
            fact: 'state',
            operator: 'equal',
            value: 'STARTUP',
          },
        ],
      },
      event: {
        type: 'transition',
        params: {
          newState: 'MEASURING',
        },
      },
    })

    // Rule to transition from MEASURING to DELAY
    this.engine.addRule({
      conditions: {
        all: [
          {
            fact: 'state',
            operator: 'equal',
            value: 'MEASURING',
          },
          {
            fact: 'nextTransitionTime',
            operator: 'lessThanInclusive',
            value: {
              fact: 'currentTime',
            },
          },
          {
            fact: 'measurementValid',
            operator: 'equal',
            value: true,
          },
        ],
      },
      event: {
        type: 'transition',
        params: {
          newState: 'DELAY',
        },
      },
    })

    // Rule to fail closed when measurement did not produce a usable sensor read
    this.engine.addRule({
      conditions: {
        all: [
          {
            fact: 'state',
            operator: 'equal',
            value: 'MEASURING',
          },
          {
            fact: 'nextTransitionTime',
            operator: 'lessThanInclusive',
            value: {
              fact: 'currentTime',
            },
          },
          {
            fact: 'measurementValid',
            operator: 'equal',
            value: false,
          },
        ],
      },
      event: {
        type: 'transition',
        params: {
          newState: 'SENSOR_FAULT',
        },
      },
    })

    // Rule to return measurement-only or disabled watering pairings to idle
    this.engine.addRule({
      conditions: {
        all: [
          {
            fact: 'state',
            operator: 'equal',
            value: 'DELAY',
          },
          {
            fact: 'nextTransitionTime',
            operator: 'lessThanInclusive',
            value: {
              fact: 'currentTime',
            },
          },
          {
            fact: 'wateringEnabled',
            operator: 'equal',
            value: false,
          },
        ],
      },
      event: {
        type: 'transition',
        params: {
          newState: 'IDLE',
        },
      },
    })

    // Rule to transition from DELAY to VALVE_OPEN. The state machine computes
    // wateringShouldOpen from the configured hysteresis band and episode state.
    this.engine.addRule({
      conditions: {
        all: [
          {
            fact: 'state',
            operator: 'equal',
            value: 'DELAY',
          },
          {
            fact: 'nextTransitionTime',
            operator: 'lessThanInclusive',
            value: {
              fact: 'currentTime',
            },
          },
          {
            fact: 'wateringShouldOpen',
            operator: 'equal',
            value: true,
          },
          {
            fact: 'wateringEnabled',
            operator: 'equal',
            value: true,
          },
          {
            fact: 'wateringMeasurementValid',
            operator: 'equal',
            value: true,
          },
        ],
      },
      event: {
        type: 'transition',
        params: {
          newState: 'VALVE_OPEN',
        },
      },
    })

    // Rule to skip valve activity when measured water content is outside the
    // active watering band.
    this.engine.addRule({
      conditions: {
        all: [
          {
            fact: 'state',
            operator: 'equal',
            value: 'DELAY',
          },
          {
            fact: 'nextTransitionTime',
            operator: 'lessThanInclusive',
            value: {
              fact: 'currentTime',
            },
          },
          {
            fact: 'wateringShouldOpen',
            operator: 'equal',
            value: false,
          },
          {
            fact: 'wateringEnabled',
            operator: 'equal',
            value: true,
          },
          {
            fact: 'wateringMeasurementValid',
            operator: 'equal',
            value: true,
          },
        ],
      },
      event: {
        type: 'transition',
        params: {
          newState: 'IDLE',
        },
      },
    })

    // Rule to fail closed if a watering-enabled pairing reaches watering logic
    // without a calibrated, fresh percent value.
    this.engine.addRule({
      conditions: {
        all: [
          {
            fact: 'state',
            operator: 'equal',
            value: 'DELAY',
          },
          {
            fact: 'nextTransitionTime',
            operator: 'lessThanInclusive',
            value: {
              fact: 'currentTime',
            },
          },
          {
            fact: 'wateringEnabled',
            operator: 'equal',
            value: true,
          },
          {
            fact: 'wateringMeasurementValid',
            operator: 'equal',
            value: false,
          },
        ],
      },
      event: {
        type: 'transition',
        params: {
          newState: 'SENSOR_FAULT',
        },
      },
    })

    // Rule to transition from VALVE_OPEN to VALVE_CLOSE
    this.engine.addRule({
      conditions: {
        all: [
          {
            fact: 'state',
            operator: 'equal',
            value: 'VALVE_OPEN',
          },
          {
            fact: 'nextTransitionTime',
            operator: 'lessThanInclusive',
            value: {
              fact: 'currentTime',
            },
          },
        ],
      },
      event: {
        type: 'transition',
        params: {
          newState: 'VALVE_CLOSE',
        },
      },
    })

    // Rule to retry measurement after a sensor fault cooldown
    this.engine.addRule({
      conditions: {
        all: [
          {
            fact: 'state',
            operator: 'equal',
            value: 'SENSOR_FAULT',
          },
          {
            fact: 'nextTransitionTime',
            operator: 'lessThanInclusive',
            value: {
              fact: 'currentTime',
            },
          },
        ],
      },
      event: {
        type: 'transition',
        params: {
          newState: 'MEASURING',
        },
      },
    })

    // Rule to transition from VALVE_CLOSE to IDLE
    this.engine.addRule({
      conditions: {
        all: [
          {
            fact: 'state',
            operator: 'equal',
            value: 'VALVE_CLOSE',
          },
          {
            fact: 'nextTransitionTime',
            operator: 'lessThanInclusive',
            value: {
              fact: 'currentTime',
            },
          },
        ],
      },
      event: {
        type: 'transition',
        params: {
          newState: 'IDLE',
        },
      },
    })

    // Rule to transition from IDLE to MEASURING
    this.engine.addRule({
      conditions: {
        all: [
          {
            fact: 'state',
            operator: 'equal',
            value: 'IDLE',
          },
          {
            fact: 'nextTransitionTime',
            operator: 'lessThanInclusive',
            value: {
              fact: 'currentTime',
            },
          },
        ],
      },
      event: {
        type: 'transition',
        params: {
          newState: 'MEASURING',
        },
      },
    })

    // Rule to transition to DISABLED state if needed
    this.engine.addRule({
      conditions: {
        all: [
          {
            fact: 'state',
            operator: 'equal',
            value: 'DISABLED',
          },
        ],
      },
      event: {
        type: 'transition',
        params: {
          newState: 'DISABLED',
        },
      },
    })
  }

  async evaluateRules(facts: any) {
    return await this.engine.run(facts)
  }

  getEngine(): Engine {
    return this.engine
  }
}
