// Enum for API endpoints or SWR keys
export enum APIEndpoint {
    Groups = '/api/groups',
    Users = '/api/users',
    Sensors = '/api/sensors',
    SensorReadings = '/api/sensor-readings',
    Zones = '/api/zones',
    Valves = '/api/valves',
    Rules = '/api/rules',
    Pairs = '/api/pairs',
    Logs = '/api/logs',
    Calibrations = '/api/calibrations'
}


// Group related types
export interface Group {
    id: number;
    name: string;
    type: 'group' | 'block' | '';
}


// User related types
export interface User {
    id: string;
    username: string;
    email: string;
    firstname: string | null;
    lastname: string | null;
    isAdmin: boolean;
    isActive: boolean;
}

// Sensor related types
export interface Sensor {
    id: number;
    name: string;
    type: string;
    description: string | null;
    address: string | null;
    boardSerialId: string | null;
}

// Sensor readings
export interface Reading {
    id: string;
    sensorId: number;
    rawValue: number;
    calibratedValue: number;
    temperature?: number | null;
    electricalConductivity?: number | null;
    createdAt: string;
    updatedAt: string;
}

// Valve related types
export interface Valve {
    id: number;
    address: string;
    relayAddress: string;
}

// Changed Pair to Pairing to match SQL table name
export interface Pairing {
    name: string;
    sensorId: number;
    valveId: number;
    groupId?: number;
    WTCPercentLimit?: number;
    ValveOpenTime?: number;
    MeasurementInterval?: number;
    calibrationValue?: number;
    calibrationId?: number;
    Sensor?: Sensor;
    Valve?: Valve;
}


// Zone related types
export interface Zone {
    id: string;
    name: string;
    description: string | null;
}


// Rules related types
export interface Rule {
    id: string;
    rule: object;
}

// Logs related types
export interface Log {
    id: number;
    level: string;
    message: string;
    data: Record<string, unknown>;
    createdAt: Date;
    updatedAt: Date;
}


export interface System {
    id: number;
    state: MachineState;
    configuration: {
        boardConfigs?: BoardConfig[];
    };
}

export enum MachineState {
    STARTUP = 'STARTUP',
    RUNNING = 'RUNNING',
    STOPPED = 'STOPPED',
    UPDATE = 'UPDATE',
    RESET = 'RESET',
    INITIALIZING = 'INITIALIZING',
}

export interface BoardConfig {
    address: number;
    resetPin?: number;
}

export interface ReadingPaginationMetadata {
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
}

export interface PaginationMetadata {
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
}

export interface PaginatedResponse<T> {
    data: T[];
    pagination: PaginationMetadata;
}

export enum ValveAction {
    OPEN = 'OPEN',
    CLOSE = 'CLOSE'
}
