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
})
