import { SerialController } from "./serialController"

export class SDI12Commands {
  constructor(private serialController: SerialController) { }

  /**
   * @returns The SDI-12 firmware version.
   */
  public async getDeviceInfo(): Promise<string> {
    return this.serialController.sendCommand("zI")
  }

  /**
   * @returns The SDI-12 device address.
   */
  public async getDeviceAddress(): Promise<string> {
    return this.serialController.sendCommand("?")
  }

  /**
   * Sends an identification command to a sensor.
   * This is used for checking sensor existence.
   * @param address The sensor's SDI-12 address.
   * @returns The sensor's identification information.
   */
  public async getSensorIdentification(address: string): Promise<string> {
    return this.serialController.sendCommand(`${address}I`)
  }

  /**
   * Initiates a measurement on the sensor at the given SDI-12 address.
   * @param address The sensor's SDI-12 address.
   */
  public async startMeasurement(address: string): Promise<string> {
    return this.serialController.sendCommand(`${address}M`)
  }

  /**
   * Reads the measurement data from the sensor at the given SDI-12 address.
   * @param address The sensor's SDI-12 address.
   */
  public async readMeasurementData(address: string): Promise<string> {
    return this.serialController.sendCommand(`${address}D0`)
  }

  /**
   * Changes the address of a sensor from the current address to a new address.
   * @param currentAddress The sensor's current SDI-12 address.
   * @param newAddress The desired new SDI-12 address.
   * @returns The new address if successful.
   */
  public async changeSensorAddress(currentAddress: string, newAddress: string): Promise<string> {
    return this.serialController.sendCommand(`${currentAddress}A${newAddress}`)
  }
}
