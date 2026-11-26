import { SoilData } from '../controllers/utilities/soilData'
jest.mock('../controllers/serialController', () => ({ SerialController: jest.fn() }))
jest.mock('../controllers/usbDetector', () => ({ USBDetector: jest.fn() }))
import { SerialControllerPool } from '../controllers/serialControllerPool'

test('accepts signed sensor data and rejects acknowledgements and foreign addresses', () => {
  expect(() => new SoilData('A0013', 'A')).toThrow()
  expect(() => new SoilData('T+2519.3+22.1+0', 'A')).toThrow()
  expect(new SoilData('T2519.3+22.1+0', 'T').volumetricWaterContent).toBe(2519.3)
  expect(new SoilData('A+0+1+3', 'A').volumetricWaterContent).toBe(0)
})

test('same-board reads wait for completion and recover after failure; other boards can read', async () => {
  const pool = SerialControllerPool.getInstance()
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  const first = pool.withMeasurement('E', async () => { await pending; throw Error('reader failed') })
  const nextRead = jest.fn(async () => 2)
  const next = pool.withMeasurement('E', nextRead)
  await expect(pool.withMeasurement('D', async () => 3)).resolves.toBe(3)
  expect(nextRead).not.toHaveBeenCalled()
  finish()
  await expect(first).rejects.toThrow('reader failed')
  await expect(next).resolves.toBe(2)
})
