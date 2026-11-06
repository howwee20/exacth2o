import * as usb from "usb";

export interface SDI12Adapter {
  device: usb.Device;
  serialNumber: string;
}

export class USBDetector {
  private static readonly SDI12_VID = 0x0403; // FTDI Vendor ID
  private static readonly SDI12_PID = 0x6015; // FTDI Product ID (optional filter)

  private deviceSerialNumbers: Record<string, string> = {}; // Store serials

  /**
   * List all connected USB devices.
   */
  public listDevices(): void {
    console.log("Connected USB Devices:");
    const devices = usb.getDeviceList();

    if (devices.length === 0) {
      console.log("No USB devices detected.");
      return;
    }

    devices.forEach(device => {
      console.log(
        `VID: ${device.deviceDescriptor.idVendor.toString(16).toUpperCase()}, `
        + `PID: ${device.deviceDescriptor.idProduct.toString(16).toUpperCase()}`
      );
    });
  }

  /**
   * Find an SDI-12 adapter based on Vendor ID (VID) and Product ID (PID).
   * @returns The first detected SDI-12 adapter or null if not found.
   */
  public async findSDI12Adapter(): Promise<{ device: usb.Device, serialNumber: string } | null> {
    const devices = usb.getDeviceList();

    const adapter = devices.find(device =>
      Number(device.deviceDescriptor.idVendor) === Number(USBDetector.SDI12_VID)
      // && Number(device.deviceDescriptor.idProduct) === Number(USBDetector.SDI12_PID)
    );

    if (!adapter) {
      console.error("No SDI-12 adapter found.");
      return null;
    }

    console.log("SDI-12 adapter detected!");

    const serialNumber = await this.readSerialNumber(adapter);
    return { device: adapter, serialNumber };
  }

  /**
   * Finds all SDI-12 adapters based on Vendor ID and Product ID.
   * @returns An array of adapter objects containing the USB device and its serial number.
   */
  public async findAllSDI12Adapters(): Promise<SDI12Adapter[]> {
    const devices = usb.getDeviceList();
    const adapters: SDI12Adapter[] = [];

    console.log(`Found USB devices: ${JSON.stringify(devices.entries(), null,2)}\n\nfiltering for SDI-12 adapters...`);

    const filteredDevices = devices.filter(device =>
      device.deviceDescriptor.idVendor === USBDetector.SDI12_VID
      // && device.deviceDescriptor.idProduct === USBDetector.SDI12_PID
    );

    console.log(`Found ${filteredDevices.length} potential SDI-12 USB adapters`);

    for (const device of filteredDevices) {
      try {
        const serialNumber = await this.readSerialNumber(device);
        adapters.push({ device, serialNumber });
      } catch (error) {
        console.error("Error reading serial number for a device:", error);
      }
    }
    return adapters;
  }

  /**
   * Reads and stores the serial number of a given USB device.
   * @param device The USB device to read the serial number from.
   * @returns A Promise resolving to the serial number.
   */
  public async readSerialNumber(device: usb.Device): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!device) {
        reject("Invalid device provided.");
        return;
      }

      device.open();
      device.getStringDescriptor(device.deviceDescriptor.iSerialNumber, (err, serial) => {
        device.close();

        if (err) {
          console.error("Error reading serial number:", err);
          reject(err);
          return;
        }

        if (!serial) {
          console.warn("No serial number found for device.");
          reject("No serial number found.");
          return;
        }

        this.deviceSerialNumbers[serial] = serial; // Store for reference
        resolve(serial);
      });
    });
  }

  /**
   * Get all stored serial numbers of detected SDI-12 adapters.
   * @returns A list of stored serial numbers.
   */
  public getStoredSerialNumbers(): string[] {
    return Object.values(this.deviceSerialNumbers);
  }
}
