export interface TimingSet {
  startDelayTime: number
  measurementTime: number
  delayTime: number
  valveOpenTime: number
  intervalTime: number
}

export enum MachineState {
  STARTUP = 'STARTUP',
  RUNNING = 'RUNNING',
  STOPPED = 'STOPPED',
  UPDATE = 'UPDATE',
  RESET = 'RESET',
}

export interface ISensor {
  id: number,
  address: string,
  type: string,
  description: string,
  name: string,
  boardSerialId: string | null,
  createdAt: string,
  updatedAt: string
}

export interface IValve {
  id: number,
  address: string,
  relayAddress: string,
  description: string,
  name: string,
  createdAt: string,
  updatedAt: string
}

export interface ICalibration {
  id: number,
  name: string,
  polynomialCoefficientsCommaDelimited: string,
  readingsJSONString: string
}

export interface IPairing {
  sensorId: number,
  valveId: number,
  groupId: number,
  name: string,
  WTCPercentLimit: number,
  ValveOpenTime: number,
  MeasurementInterval: number,
  Sensor: ISensor,
  Valve: IValve,
  Calibration?: ICalibration,
  createdAt: string,
  updatedAt: string
}

export interface PairingState extends IPairing {
  state: 'STARTUP' | 'IDLE' | 'MEASURING' | 'DELAY' | 'VALVE_OPEN' | 'VALVE_CLOSE' | 'DISABLED' | 'SENSOR_FAULT'
  timingRules: TimingSet
  WTCPercentMeasured: number | null,
  lastMeasurementAt: number | null,
  previousWTCPercentMeasured: number | null,
  previousMeasurementAt: number | null,
  measurementValid: boolean,
  wateringMeasurementValid: boolean,
  valveOpened: boolean,
  lastValveOpenedAt: number | null,
  wateringWindowStartedAt: number | null,
  wateringWindowPulseCount: number,
  nextTransitionTime: number | null
}

export type PairingStateType = PairingState['state'];
