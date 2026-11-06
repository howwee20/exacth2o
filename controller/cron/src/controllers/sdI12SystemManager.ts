import { USBDetector } from "./usbDetector";
import { SerialController } from "./serialController";
import { SDI12Commands } from "./sdI12Commands";
import { SoilData } from "./utilities/soilData";
import { SDI12SystemInitializer } from "./sdI12SystemInitializer";
import { SerialControllerPool } from "./serialControllerPool";

export interface BoardSensorData {
  boardSerial: string;
  sensorData: { [address: string]: ReturnType<SoilData["getParsedData"]> };
}

/**
 * SDI12SystemManager coordinates retrieval of sensor data from all connected SDI‑12 boards,
 * and for each board, from each Teros soil sensor (each with a unique SDI‑12 address).
 */
export class SDI12SystemManager {
  private usbDetector: USBDetector;
  private initializer: SDI12SystemInitializer;

  constructor() {
    this.usbDetector = new USBDetector();
    this.initializer = new SDI12SystemInitializer();
  }

  //getter and setter for SDI12SystemInitializer
  getInitializer(): SDI12SystemInitializer {
    return this.initializer;
  }

  setInitializer(initializer: SDI12SystemInitializer): void {
    this.initializer = initializer
  }

  /**
   * Retrieves all connected SDI‑12 adapters.
   */
  async getAllAdapters(): Promise<Array<{ device: any; serialNumber: string }>> {
    return await this.usbDetector.findAllSDI12Adapters();
  }

  async getOrCreateController(boardSerial: string): Promise<SerialController> {
    // Use the pool instead of a local map
    return await SerialControllerPool.getInstance().getController(boardSerial);
  }

  async closeAllConnections() {
    // Use the pool to close all
    await SerialControllerPool.getInstance().closeAll();
  }

  /**
   * Retrieves data from a specific sensor on a specific board.
   *
   * @param boardSerial The serial number of the target board.
   * @param sensorAddress The SDI-12 address of the target sensor on that board.
   * @returns The parsed sensor data object, or null if the board/sensor is not configured,
   *          or if there was an error communicating or parsing the data.
   */
  async getSpecificSensorData(
    boardSerial: string,
    sensorAddress: string
  ): Promise<ReturnType<SoilData["getParsedData"]> | null> {
    console.log(`Attempting to read data from sensor ${sensorAddress} on board ${boardSerial}...`);

    // 1. Check configuration first
    const boardSensorMap = this.initializer.getBoardSensorMap();
    console.log(`Current boardSensorMap:`, boardSensorMap);
    const configuredSensors = boardSensorMap.get(boardSerial);
    console.log(`Configured sensors for board ${boardSerial}:`, configuredSensors);

    if (!configuredSensors) {
      console.warn(`Board ${boardSerial} not found in the current configuration.`);
      return null;
    }
    if (!configuredSensors.includes(sensorAddress)) {
      console.warn(`Sensor address ${sensorAddress} is not configured for board ${boardSerial}.`);
      return null;
    }
    console.log(`Sensor ${sensorAddress} is configured for board ${boardSerial}. Proceeding with read attempt.`);

    try {
      const controller = await this.getOrCreateController(boardSerial);
      // Optionally: lock per controller to serialize access
      console.log(`Waiting after openConnection for board ${boardSerial}...`);

      await new Promise(resolve => setTimeout(resolve, 2500)); // e.g., 2.5 seconds

      const sdi12 = new SDI12Commands(controller);

      // 3. Perform Measurement Sequence for the single sensor
      console.log(`Starting measurement for sensor ${sensorAddress} on board ${boardSerial}`);
      await sdi12.startMeasurement(sensorAddress);

      // Wait for measurement completion
      await new Promise(resolve => setTimeout(resolve, 2000)); // Standard 2s wait

      console.log(`Reading measurement data from sensor ${sensorAddress} on board ${boardSerial}`);
      const rawData = await sdi12.readMeasurementData(sensorAddress);
      console.log(`Raw data for sensor ${sensorAddress} on board ${boardSerial}: ${rawData}`);

      // 4. Parse Data
      const parsedData = new SoilData(rawData).getParsedData();
      console.log(`Successfully parsed data for sensor ${sensorAddress} on board ${boardSerial}.`);
      return parsedData;

    } catch (error) {
      console.error(`Error reading sensor ${sensorAddress} on board ${boardSerial}:`, error);
      return null; // Return null on any error during the process
    }
  }

  /**
   * For each detected board, queries all sensors (by their SDI‑12 addresses) and returns an array of results.
   * Only queries the sensors that are actually configured for each board.
   * @param sensorAddresses Optional array of sensor addresses to query. If not provided, uses all configured sensors.
   */
 async getAllSensorData(sensorAddresses?: string[]): Promise<BoardSensorData[]> {
    const boardsData: BoardSensorData[] = [];
    // Use the single initializer instance to get the current config
    const boardSensorMap = this.initializer.getBoardSensorMap();

    if (boardSensorMap.size === 0) {
        console.log("No boards configured in the system.");
        return boardsData;
    }

    // Prepare the set of addresses to query ON EACH BOARD
    // If sensorAddresses is provided, query only those. Otherwise, query all configured for the board.
    const queryAddressSet = sensorAddresses && sensorAddresses.length > 0 ? new Set(sensorAddresses) : null;

    // Get all detected adapters
    const adapters = await this.getAllAdapters();
    if (!adapters.length) {
      console.warn("No SDI-12 boards detected during read operation."); // Changed to warn
      return boardsData;
    }

    // Process each *detected* adapter individually.
    for (const adapter of adapters) {
      const boardSerial = adapter.serialNumber;

      // Check if this detected board is actually in our configuration
      const configuredSensorsForBoard = boardSensorMap.get(boardSerial);
      if (!configuredSensorsForBoard || configuredSensorsForBoard.length === 0) {
        console.log(`Detected board ${boardSerial} is not in config or has no configured sensors. Skipping.`);
        continue;
      }

      console.log(`Processing configured board with Serial Number: ${boardSerial}`);

      // Determine which addresses to query for *this specific board*
      let addressesToQueryThisBoard: string[];
      if (queryAddressSet) {
          // Filter the board's configured sensors by the requested set
          addressesToQueryThisBoard = configuredSensorsForBoard.filter(addr => queryAddressSet.has(addr));
          if (addressesToQueryThisBoard.length === 0) {
              console.log(`Requested sensor addresses [${sensorAddresses?.join(',')}] not found on board ${boardSerial}. Skipping board.`);
              continue;
          }
           console.log(`Querying specific addresses on board ${boardSerial}: ${addressesToQueryThisBoard.join(', ')}`);
      } else {
          // Query all configured sensors for this board
          addressesToQueryThisBoard = configuredSensorsForBoard;
           console.log(`Querying all configured sensors on board ${boardSerial}: ${addressesToQueryThisBoard.join(', ')}`);
      }

      // Use the pool for controller
      const serialController = await SerialControllerPool.getInstance().getController(boardSerial);
      try {
        await serialController.openConnection(boardSerial); // This will be a no-op if already open
        console.log(`Waiting after openConnection for board ${boardSerial}...`);
        await new Promise(resolve => setTimeout(resolve, 2500)); // Increased to 2.5 seconds
        const sdi12 = new SDI12Commands(serialController);

        try {
            const deviceInfo = await sdi12.getDeviceInfo();
            console.log(`Device Info for board ${boardSerial}: ${deviceInfo}`);
        } catch (ziError: any) {
            console.warn(`Warning: Failed to get device info (zI!) for board ${boardSerial}. Error: ${ziError?.message || ziError}. Proceeding with sensor reads...`);
        }

        const sensorDataMap: { [address: string]: ReturnType<SoilData["getParsedData"]> } = {};

        // Query each relevant sensor on this board by its SDI-12 address.
        for (const address of addressesToQueryThisBoard) {
          try {
            console.log(`Querying sensor at address ${address} on board ${boardSerial}`);
            await sdi12.startMeasurement(address);

            // Wait for the measurement to complete.
            await new Promise(resolve => setTimeout(resolve, 2000));

            const rawData = await sdi12.readMeasurementData(address);
            console.log(`Raw data for sensor ${address} on board ${boardSerial}: ${rawData}`);

            // Parse the raw measurement using SoilData.
            const parsedData = new SoilData(rawData).getParsedData();
            sensorDataMap[address] = parsedData;
          } catch (error) {
            console.warn(`Error querying sensor at address ${address} on board ${boardSerial}:`, error);
          }
        } // End loop through addresses on this board

        // Only add board data if we successfully read from at least one sensor
        if (Object.keys(sensorDataMap).length > 0) {
            boardsData.push({ boardSerial, sensorData: sensorDataMap });
        } else {
             console.log(`No sensor data successfully read from board ${boardSerial}.`);
        }

      } catch (error) {
        console.error(`Error processing board ${boardSerial}:`, error);
      } finally {
        // Optionally, release controller if you want to close after each use:
        // await SerialControllerPool.getInstance().releaseController(boardSerial);
      }
    } // End loop through adapters

    return boardsData;
  }

}
