import { Expand13ControllerManager, BoardConfig } from '../controllers/Expand13Manager'
import { Expand13Controller } from '../controllers/Expand13Controller'
import { ApiService } from './ApiService'
import { API_ENDPOINTS, VALVE_CONFIGURATION } from '../config/constants'

/**
 * Service responsible for managing valve operations
 */
export class ValveService {
  private valveManager: Expand13ControllerManager | undefined = undefined
  private pinStates: Map<number, boolean> = new Map()
  private valveBoardConfigs: BoardConfig[] = []

  constructor(private apiService: ApiService) {}

  async setupValveConfigs(): Promise<void> {
    let valveNumber = 1

    for (let boardIndex = 0; boardIndex < this.valveBoardConfigs.length; ++boardIndex) {
      const config = this.valveBoardConfigs[boardIndex]
      console.log(`Initializing board: ${config.address}`)

      for (let pin = 0; pin < VALVE_CONFIGURATION.ROWS; ++pin) {
        for (let column = 0; column < VALVE_CONFIGURATION.COLS; ++column) {
          this.pinStates.set(this.calculatePinAddress(column, pin), false)
          console.log(`creating valve ${valveNumber} in API: at location ${config.address}/#0x${config.address.toString(16)}: [${column}][${pin}]`)
          this.operateValve(config.address, column, pin, 'CLOSE')

          await this.apiService.postData(API_ENDPOINTS.VALVES, {
            "name": `valve-${valveNumber}`,
            "description": `valve #${valveNumber} at on board ${boardIndex}/#0x${config.address.toString(16)}: pin [${column}][${pin}]`,
            "address": `${(pin) * VALVE_CONFIGURATION.COLS + (column + 1)}`,
            "relayAddress": `0x${config.address.toString(16)}`,
          })

          ++valveNumber
        }
      }
    }
  }

  operateValve(boardAddress: number, column: number, pin: number, state: 'OPEN' | 'CLOSE'): void {
    if (this.valveManager) {
      try {
        console.log(`Operating valve on board ${boardAddress}: [${column}][${pin}] state: ${state}`)
        this.valveManager.setMultiplePinsOnBoard(boardAddress, [{ column, pin, active: state === 'OPEN' }])
      }
      catch (error: any) {
        console.error(`Error operating valve on board ${boardAddress}:`, error)
        throw new Error(`Failed to operate valve on board ${boardAddress}: ${error.message}`)
      }
    }
    else {
      console.error(`ValveManager is not initialized. Cannot operate valve on board ${boardAddress}.`)
      throw new Error(`ValveManager is not initialized. Cannot operate valve on board ${boardAddress}.`)
    }
  }

  calculatePinAddress(column: number, pin: number): number {
    return (column) * VALVE_CONFIGURATION.ROWS + (pin + 1)
  }

  calculateColumnAndPin(address: number): { column: number, pin: number } {
    const column = Math.floor((address - 1) / VALVE_CONFIGURATION.ROWS)
    const pin = (address - 1) % VALVE_CONFIGURATION.ROWS
    return { column, pin }
  }

  getValveBoardConfigs(scanForAddresses: boolean = false): BoardConfig[] {
    let valveBoardConfigs: BoardConfig[] = this.valveBoardConfigs
    console.log('Getting valve board configurations')

    if (scanForAddresses) {
      const addresses = Expand13Controller.scanForAddresses(1)
      console.log('Found addresses:', addresses)

      if (addresses.length === 0) {
        console.warn('No addresses found on the I2C bus. Using default board configurations.')
        // Return default configs - will be set by caller
      } else {
        console.log('Using found addresses for board configurations:', addresses)
        valveBoardConfigs = addresses.map(address => ({ address, resetPin: 16 }))
      }
    }

    return valveBoardConfigs
  }

  async setBoardConfigs(boardConfigs: BoardConfig[], updateAPI: boolean = false): Promise<boolean> {
    if (this.valveManager) {
      try {
        // Clean up if needed
      } catch (error) {
        console.error('Error cleaning up valve manager:', error)
        return false
      }
    }

    console.log('Setting board configurations:', boardConfigs)
    this.valveBoardConfigs = boardConfigs
    this.valveManager = new Expand13ControllerManager(boardConfigs)

    console.log('Board configurations set:', boardConfigs)
    if (updateAPI) {
      console.log('Updating board configurations in API')
      await this.apiService.postData(API_ENDPOINTS.BOARD_CONFIGS, boardConfigs)
      console.log('Board configurations updated in API')
    }

    return true
  }

  getBoardConfigs(): BoardConfig[] {
    return this.valveBoardConfigs
  }

  closeAllValves(): void {
    if (!this.valveManager) {
      throw new Error('ValveManager is not initialized. Cannot close valves.')
    }

    console.log('Closing all valves...')
    const failures: string[] = []
    const boards: BoardConfig[] = this.getBoardConfigs()
    for (const board of boards) {
      for (let column = 0; column < VALVE_CONFIGURATION.COLS; ++column) {
        for (let pin = 0; pin < VALVE_CONFIGURATION.ROWS; ++pin) {
          try {
            this.operateValve(board.address, column, pin, 'CLOSE')
          } catch (error: any) {
            failures.push(
              `${board.address}:${column}:${pin}: ${error?.message || String(error)}`
            )
          }
        }
      }
    }

    if (failures.length > 0) {
      throw new Error(`Failed to close ${failures.length} valve outputs: ${failures.join('; ')}`)
    }
    console.log('All valves closed.')
  }
}
