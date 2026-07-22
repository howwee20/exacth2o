/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only'

import { requireUiSession } from './server-auth';

export class ApiClient {
  private baseUrl: string;
  private timeoutMs: number;
  private allowAnonymous: boolean;

  constructor(options: { allowAnonymous?: boolean } = {}) {
    // This will be your internal Docker service URL when running server-side
    this.baseUrl = process.env.API_URL || 'http://api_svc:8888/v1';
    const parsedTimeout = Number.parseInt(process.env.API_REQUEST_TIMEOUT_MS || '', 10);
    this.timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 10000;
    this.allowAnonymous = options.allowAnonymous === true;
  }

  private async fetchWithConfig(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<any> {
    if (!this.allowAnonymous) await requireUiSession();
    const url = `${this.baseUrl}${endpoint}`;
    console.log('fetching', url);
    const defaultHeaders = {
      'Content-Type': 'application/json',
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          ...defaultHeaders,
          ...(
            options.method && options.method !== 'GET'
              ? { 'x-exacth2o-controller-secret': process.env.EXACTH2O_CONTROLLER_COMMAND_SECRET || '' }
              : {}
          ),
          ...options.headers,
        },
      });

      if (!response.ok) {
        try {
          const errorText = await response.text();
          throw new Error(`API error: ${response.status} ${errorText}`);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (err) {
          throw new Error(`API error: ${response.status}`);
        }
      }

      return await response.json();
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        throw new Error(`API request timed out after ${this.timeoutMs}ms: ${endpoint}`);
      }
      console.error('API request failed:', error);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async get(endpoint: string) {
    return this.fetchWithConfig(endpoint, { method: 'GET' });
  }

  async post(endpoint: string, data: any) {
    return this.fetchWithConfig(endpoint, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }


  async put(endpoint: string, data: any) {
    return this.fetchWithConfig(endpoint, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async delete(endpoint: string) {
    return this.fetchWithConfig(endpoint, {
      method: 'DELETE',
      body: JSON.stringify({}),
    });
  }

}

// Export a singleton instance
export const apiClient = new ApiClient();
