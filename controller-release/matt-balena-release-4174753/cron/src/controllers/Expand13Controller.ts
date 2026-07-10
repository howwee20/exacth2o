import * as i2c from 'i2c-bus'

const isRaspberryPi = process.platform === 'linux'
const i2cBus: i2c.I2CBus = isRaspberryPi
  ? i2c.openSync(1)
  : require('./mocks/i2c-bus').openSync(1);

const rpio = isRaspberryPi ? require('rpio') : require('./mocks/rpio');

// Initialize rpio to use BCM (GPIO) numbering instead of physical pin mapping.
rpio.init({ mapping: 'gpio', gpiomem: false });
const I2C_BUS_NUMBER = 1;        // Typically, the Raspberry Pi uses bus 1
const I2C_ADDRESS = 0x20;        // Default I2C address
const NUM_COLUMNS = 6           // 6 columns, each 8 bits (48 total I/Os)
const PINSTATE_HIGH = 0xFF        // All bits HIGH
const PINSTATE_LOW = 0x00         // All bits LOW

/**

 * In an active-low configuration:
 * - A value of 0xFF in a column means all 8 pins are off (inactive, Relay off).
 * - Clearing a bit drives that pin low, “activating” it (Relay on).
 */
export class Expand13Controller {
  public address: number;
  private bus: i2c.I2CBus;
  // Global state: an array of 6 numbers, one per column. Initially, all columns are 0x00 (all relays off).
  private portState: number[];
  private resetPin?: number;

   /**
   * @param busNumber I²C bus number (default is 1)
   * @param address I²C address of the board
   * @param resetPin BCM GPIO number used to control the board's RESET pin.
   */
  constructor(
    private busNumber: number = I2C_BUS_NUMBER,
    address: number = I2C_ADDRESS,
    resetPin?: number,
  ) {
    this.address = address;
    // Initialize with all pins HIGH (relays deactivated)
    this.portState = new Array(NUM_COLUMNS).fill(PINSTATE_HIGH);
    this.bus = i2c.openSync(this.busNumber);
    this.resetPin = resetPin;
    // Initialize RESET pin as an output and drive it high.
    if (this.resetPin !== undefined) {
      rpio.open(this.resetPin, rpio.OUTPUT, rpio.HIGH);
      console.log(`RESET pin (GPIO${this.resetPin}) set to high using rpio for board at address 0x${this.address.toString(16)}.`);
    }
  }
  /**
   * Scans the provided I²C bus numbers for the target device address.
   * @param targetAddress The I²C address to look for (default is the controller's address)
   * @param busNumbers An array of bus numbers to scan (default: [1, 20, 21])
   * @returns An array of bus numbers on which the device was found.
   */
  public static scanBusesForDevice(
    targetAddress: number = I2C_ADDRESS,
    busNumbers: number[] = [1, 20, 21]
  ): number[] {
    const foundBuses: number[] = [];

    for (const busNum of busNumbers) {
      try {
        // const bus = i2c.openSync(busNum);
        // // scanSync scans addresses in the range 0x03 to 0x77 by default
        const addresses: number[] = Expand13Controller.scanForAddresses(busNum) //bus.scanSync();
        console.log(
          `Bus ${busNum}: Found devices at addresses: ${addresses
            .map((a) => "0x" + a.toString(16))
            .join(", ")}`
        );
        if (addresses.includes(targetAddress)) {
          console.log(
            `Target device (0x${targetAddress.toString(16)}) found on bus ${busNum}.`
          );
          foundBuses.push(busNum);
        }

      } catch (err) {
        console.error(`Error scanning bus ${busNum}: ${err}`);
      }
    }

    return foundBuses;
  }

  public static scanForAddresses(busNumber: number = I2C_BUS_NUMBER): number[] {
    const bus = i2c.openSync(busNumber)
    try {
      // scanSync scans addresses in the range 0x03 to 0x77 by default
      const addresses: number[] = bus.scanSync()
      console.log(`Found devices at addresses: ${addresses.map(a => "0x" + a.toString(16)).join(", ")}`)
      return addresses
    } catch (err) {
      console.error(`Error scanning bus ${busNumber}: ${err}`)
      return []
    } finally {
      bus.closeSync()
    }
  }

  // FIXED: Uses sequential byte writes instead of register-based writes
  // The PI4IOE5V96248 expects sequential bytes starting with Port 0 (IO0_7 to IO0_0)
  private writePortState(): void {
    try {
      console.log(`Writing sequential bytes to address 0x${this.address.toString(16)}: [${this.portState.map(x => '0x' + x.toString(16).padStart(2, '0')).join(', ')}]`)

      // CRITICAL FIX: Use i2cWriteSync with sequential bytes, NOT writeByteSync with registers
      // The PI4IOE5V96248 expects: START + ADDRESS + DATA_BYTE_0 + DATA_BYTE_1 + ... + DATA_BYTE_5 + STOP
      const buffer = Buffer.from(this.portState);
      this.bus.i2cWriteSync(this.address, buffer.length, buffer);

      console.log(`✓ Port state written successfully using sequential byte writes`);

    } catch (error) {
      const err = error as Error
      console.error(`Write failed for device 0x${this.address.toString(16)}: ${err.message}`)
      throw error
    }
  }

  /**
   * Activates a specific relay (drives pin LOW for Adafruit relay).
   * @param column - Which column (0–5)
   * @param pin - Which pin in that column (0–7)
   */
  public activatePin(column: number, pin: number): void {
    this.validatePin(column, pin);
    // SET the bit to drive that pin LOW (relay activated) - CHANGED from clearing to setting
    this.portState[column] &= ~(1 << pin);
    console.log(`Activated Column ${column}, Pin ${pin}. New state: 0x${this.portState[column].toString(16)}`);
    this.writePortState();
  }

  /**
   * Deactivates a specific relay (drives pin HIGH for Adafruit relay).
   * @param column - Which column (0–5)
   * @param pin - Which pin in that column (0–7)
   */
  public deactivatePin(column: number, pin: number): void {
    this.validatePin(column, pin);
    // CLEAR the bit to drive that pin HIGH (relay deactivated) - CHANGED from setting to clearing
    this.portState[column] |= (1 << pin);
    console.log(`Deactivated Column ${column}, Pin ${pin}. New state: 0x${this.portState[column].toString(16)}`);
    this.writePortState();
  }

  /**
   * Sets a specific pin to the desired state.
   * @param column - Which column (0–5)
   * @param pin - Which pin (0–7)
   * @param active - True to activate (drive HIGH), false to deactivate (drive LOW)
   */
  public setPin(column: number, pin: number, active: boolean): void {
    if (active) {
      this.activatePin(column, pin);
    } else {
      this.deactivatePin(column, pin);
    }
  }

  /**
   * Sets multiple pins at once.
   * Each command in the array should specify a column, a pin, and a desired state.
   * The port state is updated for each command, and then the complete state is written.
   *
   * @param commands - Array of commands, e.g. [{ column: 1, pin: 2, active: true }, ...]
   */
  public setMultiplePins(commands: Array<{ column: number, pin: number, active: boolean }>): void {
    commands.forEach(cmd => {
      this.validatePin(cmd.column, cmd.pin);
      if (cmd.active) {
        // Activate: SET bit (drive LOW) - CHANGED
        this.portState[cmd.column] &= ~(1 << cmd.pin);
      } else {
        // Deactivate: CLEAR bit (drive HIGH) - CHANGED
        this.portState[cmd.column] |= (1 << cmd.pin);
      }
      console.log(`Command for Column ${cmd.column}, Pin ${cmd.pin} set to ${cmd.active ? 'active (LOW)' : 'inactive (HIGH)'}.`);
    })
    console.log(`Updated port state after multiple commands: [${this.portState.map(x => '0x' + x.toString(16).padStart(2, '0')).join(', ')}]`);
    this.writePortState();
  }

  /**
   * Resets all outputs to the inactive state (all pins LOW) and closes the I²C bus.
   */
  public cleanup(): void {
    // Set all pins LOW (all relays deactivated) - CHANGED from 0xFF to 0x00
    this.portState = new Array(NUM_COLUMNS).fill(0x00);
    console.log('Cleanup: Setting all pins to inactive (LOW).');
    this.writePortState();
    this.bus.closeSync();

    // Ensure RESET remains high.
    if (this.resetPin !== undefined) {
      rpio.write(this.resetPin, rpio.HIGH);
      // Optionally, you can close the pin:
      // rpio.close(this.resetPin);
    }
  }

  /**
   * Validates that the given column and pin are within range.
   * @param column - Column number (0–5)
   * @param pin - Pin number (0–7)
   */
  private validatePin(column: number, pin: number): void {
    if (column < 0 || column >= NUM_COLUMNS) {
      throw new Error(`Invalid column: ${column}. Must be between 0 and ${NUM_COLUMNS - 1}.`);
    }
    if (pin < 0 || pin >= 8) {
      throw new Error(`Invalid pin: ${pin}. Must be between 0 and 7.`);
    }
  }
}
