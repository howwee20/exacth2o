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
    constructor(rawData: string) {
        if (!rawData || typeof rawData !== 'string') {
            throw new Error(`Invalid raw data provided: ${rawData}`);
        }

        // Regex to capture:
        // Group 1: Single alphanumeric character at the start (address)
        // Group 2, 3, 4: Subsequent signed floating-point numbers
        const match = rawData.match(/^([a-zA-Z0-9])([+-]\d+\.?\d*([Ee][+-]?\d+)?)([+-]\d+\.?\d*([Ee][+-]?\d+)?)([+-]\d+\.?\d*([Ee][+-]?\d+)?)$/);

        if (!match || match.length < 7) { // Expect at least 7 parts: full match, address, value1, value2, value3, and E notation groups
            // Fallback regex for potential variations (e.g., missing sign on first value, though less common)
            const fallbackMatch = rawData.match(/^([a-zA-Z0-9])(\+?-?\d+\.?\d*)\+?(-?\d+\.?\d*)\+?(-?\d+\.?\d*)$/);
             if (!fallbackMatch || fallbackMatch.length < 5) { // Ensure fallback regex produces at least 5 parts
                  throw new Error(`Invalid sensor data format: "${rawData}". Failed primary and fallback regex.`);
             }
              if (process.env.NODE_ENV !== 'production') {
                  console.warn(`DEBUG: Using fallback regex for data: "${rawData}"`);
              }
             // Use fallback match groups
             this.sensorAddress = fallbackMatch[1];
             this.volumetricWaterContent = Number(fallbackMatch[2]);
             this.temperature = Number(fallbackMatch[3]);
             this.electricalConductivity = Number(fallbackMatch[4]);

        } else {
             // Use primary match groups
             this.sensorAddress = match[1]; // The single character address
             this.volumetricWaterContent = Number(match[2]); // First value (includes sign)
             this.temperature = Number(match[4]); // Second value (index 4 because regex group 3 captures E notation part)
             this.electricalConductivity = Number(match[6]); // Third value (index 6 due to E notation group)
        }


        // Validate parsed numbers
        if (isNaN(this.volumetricWaterContent) || isNaN(this.temperature) || isNaN(this.electricalConductivity)) {
            throw new Error(`Failed to parse numeric values from sensor data: "${rawData}"`);
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