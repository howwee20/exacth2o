import { SerialController } from "./serialController";
import { USBDetector } from "./usbDetector";

/**
 * SerialControllerPool manages a pool of SerialController instances,
 * ensuring only one controller per serial number is created and reused.
 */
export class SerialControllerPool {
  private static instance: SerialControllerPool;
  private controllers: Map<string, SerialController> = new Map();
  private usbDetector: USBDetector;

  private constructor() {
    this.usbDetector = new USBDetector();
  }

  /**
   * Singleton accessor
   */
  public static getInstance(): SerialControllerPool {
    if (!SerialControllerPool.instance) {
      SerialControllerPool.instance = new SerialControllerPool();
    }
    return SerialControllerPool.instance;
  }

  /**
   * Get or create a SerialController for a given serial number.
   * Ensures only one controller per serial number is created and reused.
   */
  public async getController(serialNumber: string): Promise<SerialController> {
    let controller = this.controllers.get(serialNumber);
    if (!controller) {
      controller = new SerialController(this.usbDetector);
      await controller.openConnection(serialNumber);
      this.controllers.set(serialNumber, controller);
    } else {
      // Optionally, check if connection is open, and reopen if needed
      if (!controller.isOpen()) {
        await controller.openConnection(serialNumber);
      }
    }
    return controller;
  }

  /**
   * Release (close and remove) a controller for a given serial number.
   * Call this when you are done with a device.
   */
  public async releaseController(serialNumber: string): Promise<void> {
    const controller = this.controllers.get(serialNumber);
    if (controller) {
      await controller.closeConnection();
      this.controllers.delete(serialNumber);
    }
  }

  /**
   * Close and remove all controllers (e.g., on shutdown)
   */
  public async closeAll(): Promise<void> {
    for (const [serial, controller] of this.controllers.entries()) {
      await controller.closeConnection();
    }
    this.controllers.clear();
  }
}
