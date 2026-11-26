// src/soilData.ts

export interface ISoilData {
    sensorAddress: string; // Address of the sensor (e.g., '1', 'a')
    volumetricWaterContent: number; // Volumetric water content in percentage
    temperature: number; // Temperature in degrees Celsius
    electricalConductivity: number; // Electrical conductivity in dS/m
}


export class SoilData {
    // Store address as string to handle 'a'-'z', 'A'-'Z'
    sensorAddress: string;
    volumetricWaterContent: number;
    temperature: number;
    electricalConductivity: number;

    /**
     * Creates a SoilData instance by parsing the raw sensor data string.
     * Expected format: "<address><value1><value2><value3>"
     * where:
     *   - <address> is a single alphanumeric character (0-9, a-z, A-Z).
     *   - <valueN> are numbers, typically starting with a '+' or '-' sign.
     * Examples: "1+1807.40+20.9+0", "a+1805.61+22.8+0"
     *
     * @param rawData - The raw sensor response string.
     * @throws Error if the raw data does not match the expected format.
     */
    constructor(rawData: string, expectedAddress?: string) {
        // Some adapters omit the sign of the first value. The separators before
        // temperature and conductivity distinguish data from an M! acknowledgement.
        const match = typeof rawData === 'string' && rawData.match(
            /^([a-zA-Z0-9])([+-]?\d+\.?\d*(?:[Ee][+-]?\d+)?)([+-]\d+\.?\d*(?:[Ee][+-]?\d+)?)([+-]\d+\.?\d*(?:[Ee][+-]?\d+)?)$/,
        );
        if (!match) throw new Error(`Invalid sensor data frame: "${rawData}"`);
        this.sensorAddress = match[1];
        if (expectedAddress !== undefined && this.sensorAddress !== expectedAddress) {
            throw new Error(`Expected sensor ${expectedAddress}, received ${this.sensorAddress}`);
        }
        this.volumetricWaterContent = Number(match[2]);
        this.temperature = Number(match[3]);
        this.electricalConductivity = Number(match[4]);
        if (![this.volumetricWaterContent, this.temperature, this.electricalConductivity].every(Number.isFinite)) {
            throw new Error(`Non-finite measurement in sensor frame: "${rawData}"`);
        }
    }

    /**
     * Returns the parsed sensor data as an object suitable for UI consumption.
     * Sensor address is returned as a string.
     */
  getParsedData(): ISoilData {
      return {
        sensorAddress: this.sensorAddress,
        volumetricWaterContent: this.volumetricWaterContent,
        temperature: this.temperature,
        electricalConductivity: this.electricalConductivity,
      };
    }
}