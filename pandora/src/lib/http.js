import { config } from '../config.js';

export class HttpError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

/** fetch with a timeout, a polite User-Agent, and a clear error on failure. */
export async function fetchText(url, { timeoutMs = 20000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': config.userAgent, accept: '*/*', ...headers },
    });
    const body = await response.text();
    if (!response.ok) {
      throw new HttpError(`GET ${url} → ${response.status}`, response.status, body.slice(0, 400));
    }
    return body;
  } catch (error) {
    if (error.name === 'AbortError') throw new HttpError(`GET ${url} timed out after ${timeoutMs}ms`, 0);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url, options) {
  const text = await fetchText(url, {
    ...options,
    headers: { accept: 'application/json', ...(options?.headers ?? {}) },
  });
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(`GET ${url} returned non-JSON`, 0, text.slice(0, 200));
  }
}
