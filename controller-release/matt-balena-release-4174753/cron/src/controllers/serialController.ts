import { SerialPort, ReadlineParser } from "serialport";
import { USBDetector } from "./usbDetector";

const READING_TIMEOUT_MS = 1000; // 1 second timeout for reading data

export class SerialController {
  private serialPort: SerialPort | null = null;
  private parser: ReadlineParser | null = null;

  constructor(private usbDetector: USBDetector) {}
   /**
   * Provides access to the ReadlineParser instance.
   * @returns The ReadlineParser instance or null if the connection is not open.
   */
  public getParser(): ReadlineParser | null {
      return this.parser;
  }
  /**
   *
   * @param serialNumber
   * @returns device path or null
   */
  public async findSerialPort(serialNumber: string): Promise<string | null> {
    try{
      const devices = await SerialPort.list();

      // Suppressing detailed port listing
      console.log(`Looking for device with serial number: ${serialNumber}`);

      for (const device of devices) {
        if (device.serialNumber === serialNumber) {
          console.log(`Found matching device: ${device.path}`);
          return device.path;
        }
      }

      console.error("No matching SDI-12 serial device found.");
      return null;
    } catch (error) {
      console.error("Error listing serial ports:", error);
      return null;
    }
  }

  /**
   * Opens a serial connection to the SDI-12 device.
   * @param serialNumber The serial number of the SDI-12 device.
   */
  public async openConnection(serialNumber: string): Promise<void> {
    console.log(`[SerialController] openConnection called with serialNumber: ${serialNumber}`);
    const portPath = await this.findSerialPort(serialNumber);
    if (!portPath) {
      console.error(`[SerialController] No valid SDI-12 serial device found for S/N: ${serialNumber}`);
      throw new Error(`No valid SDI-12 serial device found for S/N: ${serialNumber}`);
    }

    if (this.serialPort && this.serialPort.isOpen) {
        console.log(`[SerialController] Serial port ${this.serialPort.path} is already open.`);
        return;
    }

    const maxRetries = 3;
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        console.log(`[SerialController] Attempt ${attempt + 1} to open serial port ${portPath}...`);
        this.serialPort = new SerialPort({ path: portPath, baudRate: 9600 });
        this.parser = this.serialPort.pipe(new ReadlineParser({ delimiter: "\r\n" }));

        // Set default listeners here? Or rely on external setting? Let's set a slightly higher default.
        // this.parser.setMaxListeners(15); // Increase default slightly

        await new Promise<void>((resolve, reject) => { // Explicitly type Promise
          const openHandler = () => {
             clearTimeout(timeoutId); // Clear timeout on successful open
             this.serialPort?.removeListener('error', errorHandler); // Clean up error listener
             console.log(`[SerialController] Serial connection opened successfully on ${portPath}`);
             resolve();
          };
          const errorHandler = (err: Error) => {
             clearTimeout(timeoutId); // Clear timeout on error
             this.serialPort?.removeListener('open', openHandler); // Clean up open listener
              // Ensure port is closed on error during opening sequence
              if (this.serialPort && this.serialPort.isOpen) {
                  this.serialPort.close();
              }
              this.serialPort = null; // Nullify references
              this.parser = null;
             console.error(`[SerialController] Error opening serial port ${portPath}:`, err);
             reject(err);
          };
           // Timeout for the open attempt itself
           const timeoutId = setTimeout(() => {
               console.error(`[SerialController] Timeout opening serial port ${portPath} on attempt ${attempt + 1}.`);
               errorHandler(new Error(`Timeout opening serial port ${portPath}`));
           }, 5000); // 5-second timeout for opening


          this.serialPort!.once("open", openHandler); // Use once for setup listeners
          this.serialPort!.once("error", errorHandler);
        });

        // Wait briefly after opening for things to stabilize
        await new Promise(resolve => setTimeout(resolve, 200));
        return; // Success, exit loop

      } catch (err) {
        console.error(`[SerialController] Attempt ${attempt + 1} failed to open serial port ${portPath}:`, err);
        // Clean up potentially partially opened port
        if (this.serialPort) {
            if (this.serialPort.isOpen) {
               this.serialPort.close();
            }
            this.serialPort = null;
            this.parser = null;
        }
        attempt++;
        if (attempt < maxRetries) {
             await new Promise(resolve => setTimeout(resolve, 1500)); // wait longer before retrying
        }
      }
    }
    console.error(`[SerialController] Unable to open serial connection on ${portPath} after ${maxRetries} attempts.`);
    throw new Error(`Unable to open serial connection on ${portPath} after ${maxRetries} attempts.`);
  }

  /**
   * Sends a command to the SDI-12 device and returns the response.
   * @param command The command to send (without trailing ! or \r\n).
   * @returns The response from the device.
   */
  public async sendCommand(command: string): Promise<string> {
    if (!this.serialPort || !this.serialPort.isOpen || !this.parser) { // Check parser too
      throw new Error("Serial connection is not open or parser not available.");
    }

    // Local promise ensures correct context for resolve/reject
    return new Promise((resolve, reject) => {
      const formattedCommand = `${command}!\r\n`;
      // Use a specific listener for this command's response
      const dataListener = (data: Buffer | string) => {
        // console.log(`DEBUG: Received data: ${data.toString().trim()}`); // Optional debug
        clearTimeout(timeoutId); // Clear timeout on receive
        resolve(data.toString().trim()); // Convert buffer to string if needed
      };

      // Timeout specifically for this command
      const timeoutId = setTimeout(() => {
        console.warn(`Timeout waiting for response to command: ${command}`);
        this.parser!.removeListener("data", dataListener); // Clean up listener on timeout
        reject(new Error(`Timeout: No response received for command ${command}!`));
      }, READING_TIMEOUT_MS); // 1-second timeout per command

      // Attach the single-use listener
      this.parser!.once("data", dataListener);

      // Write the command
      // console.log(`Sending command: ${formattedCommand.trim()}`); // Already logged elsewhere usually
      this.serialPort!.write(formattedCommand, (err) => {
        if (err) {
          clearTimeout(timeoutId); // Clear timeout on write error
          this.parser!.removeListener("data", dataListener); // Clean up listener
          console.error(`Error writing command "${command}" to serial port: ${err}`);
          reject(new Error(`Error writing to serial port: ${err.message}`));
        } else {
           // Optional: Drain ensures data is sent before proceeding, might help timing?
           this.serialPort!.drain(drainErr => {
               if (drainErr) {
                  clearTimeout(timeoutId);
                  this.parser!.removeListener("data", dataListener);
                  console.error(`Error draining serial port after writing command "${command}": ${drainErr}`);
                  reject(new Error(`Error draining serial port: ${drainErr.message}`));
               }
               // console.log(`Command ${command} written and drained.`); // Debug log
           });
        }
      });
    });
  }

  /**
   * Closes the serial connection.
   */
  public async closeConnection(): Promise<void> { // Make async for potential cleanup
    if (this.serialPort && this.serialPort.isOpen) {
      console.log(`[SerialController] Closing serial connection on ${this.serialPort.path}...`);
      const port = this.serialPort; // Capture reference
      this.serialPort = null; // Nullify references early
      this.parser = null;
      return new Promise((resolve, reject) => {
          port.close((err) => {
              if (err) {
                  console.error(`[SerialController] Error closing serial port ${port.path}:`, err);
                  reject(err);
              } else {
                  console.log(`[SerialController] Serial connection on ${port.path} closed.`);
                  resolve();
              }
          });
      });
    } else {
         // console.log("Serial connection already closed or not initialized.");
         console.log(`[SerialController] closeConnection called but serial port was already closed or not initialized.`);
         return Promise.resolve(); // Return resolved promise if already closed
    }
  }

  /**
   * Checks if the serial connection is open.
   * @returns True if the serial connection is open, false otherwise.
   */
  public isOpen(): boolean {
    return this.serialPort?.isOpen ?? false;
  }
}
