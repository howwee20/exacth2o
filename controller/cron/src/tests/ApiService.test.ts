import { ApiService } from '../services/ApiService'

describe('ApiService mutation authentication', () => {
  const originalFetch = global.fetch
  const originalSecret = process.env.EXACTH2O_CONTROLLER_COMMAND_SECRET

  afterEach(() => {
    global.fetch = originalFetch
    if (originalSecret === undefined) delete process.env.EXACTH2O_CONTROLLER_COMMAND_SECRET
    else process.env.EXACTH2O_CONTROLLER_COMMAND_SECRET = originalSecret
  })

  it('sends the controller secret with scheduler writes', async () => {
    process.env.EXACTH2O_CONTROLLER_COMMAND_SECRET = 'scheduler-secret'
    const fetchMock = jest.fn().mockResolvedValue({ json: async () => ({ ok: true }) })
    global.fetch = fetchMock as unknown as typeof fetch

    await new ApiService('http://api_svc:8888').postData('/v1/readings', { value: 1 })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api_svc:8888/v1/readings',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-exacth2o-controller-secret': 'scheduler-secret',
        }),
      }),
    )
  })

  it('fetches valve inventory once when the hold requests no retries', async () => {
    const valves = [{ relayAddress: '0x24', address: 1 }]
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => valves })
    global.fetch = fetchMock as unknown as typeof fetch

    await expect(new ApiService('http://api_svc:8888').fetchData('/v1/valves', { timeoutMs: 1500, retries: 0 })).resolves.toEqual(valves)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects unavailable inventory after one attempt when retries are disabled', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Unavailable' })
    global.fetch = fetchMock as unknown as typeof fetch

    await expect(new ApiService('http://api_svc:8888').fetchData('/v1/valves', { timeoutMs: 1500, retries: 0 })).rejects.toThrow('503 Unavailable')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
