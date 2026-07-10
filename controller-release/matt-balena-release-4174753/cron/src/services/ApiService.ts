/**
 * Service responsible for making API calls to the backend
 */
const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export class ApiService {
  constructor(private apiURL: string) {}

  async postData(endpoint: string, data: any) {
    const url = `${this.apiURL}${endpoint}`
    console.log(`Posting data: ${url}`)
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    })
      .then(response => response.json())
      .catch(error => console.error('Error posting data:', error))
  }

  async fetchData(endpoint: string) {
    const url = `${this.apiURL}${endpoint}`
    const retries = parsePositiveInt(process.env.API_FETCH_RETRIES, 1)
    const retryDelayMs = parsePositiveInt(process.env.API_FETCH_RETRY_DELAY_MS, 2000)
    let lastError: unknown

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        console.log(`Fetching data: ${url} (attempt ${attempt}/${retries})`)
        const response = await fetch(url)
        if (!response.ok) {
          throw new Error(`GET ${url} failed with ${response.status} ${response.statusText}`)
        }
        return await response.json()
      } catch (error) {
        lastError = error
        if (attempt < retries) {
          console.warn(`Error fetching data from ${url}; retrying in ${retryDelayMs}ms`, error)
          await sleep(retryDelayMs)
        }
      }
    }

    console.error(`Error fetching data from ${url} after ${retries} attempts:`, lastError)
    throw lastError instanceof Error ? lastError : new Error(`Error fetching data from ${url}`)
  }
}
