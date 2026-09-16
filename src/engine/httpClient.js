/**
 * Shared Authenticated HTTP Client
 * Handles all network requests to demonicscans.org with:
 * - Auto cookie/session/UA injection from the game webContents session
 * - Retry with exponential backoff (max 3 attempts)
 * - Timeout handling (10s default)
 * - Proper error objects (never silently swallows)
 */

const { Logger } = require('../main/logger');

class HttpClient {
  /**
   * @param {import('electron').WebContents} webContents - Game browser webContents for session access
   * @param {string} [accountName] - Account name for logging
   */
  constructor(webContents, accountName = null, timingEngine = null, fetchImpl = null) {
    this.webContents = webContents;
    this.accountName = accountName;
    this.defaultTimeout = 10000;
    this.maxRetries = 3;
    this.baseRetryDelay = 1000;
    this.timingEngine = timingEngine;
    this.activeControllers = new Set();
    this.cancelGeneration = 0;
    // Tests may inject a transport. Production requests deliberately resolve
    // the fetch function from the current account Session for every request so
    // cookie reads and Set-Cookie writes use the same persistent partition as
    // the companion browser.
    this.fetchImpl = fetchImpl;
  }

  /**
   * Update the webContents reference (e.g. after page reload)
   * @param {import('electron').WebContents} webContents
   */
  setWebContents(webContents) {
    this.webContents = webContents;
  }

  /**
   * Update account name for logging
   * @param {string} accountName
   */
  setAccount(accountName) {
    this.accountName = accountName;
  }

  /**
   * Get the Electron session from webContents
   * @returns {import('electron').Session}
   */
  _getSession() {
    if (!this.webContents || this.webContents.isDestroyed()) {
      throw new HttpClientError('Game browser session is destroyed or unavailable', 'SESSION_DESTROYED');
    }
    return this.webContents.session;
  }

  /**
   * Build cookie header string from session cookies
   * @returns {Promise<string>}
   */
  async _getCookieHeader() {
    const sess = this._getSession();
    const cookies = await sess.cookies.get({ url: 'https://demonicscans.org' });
    return cookies.map(c => `${c.name}=${c.value}`).join('; ');
  }

  async getCookies(url = 'https://demonicscans.org') {
    return this._getSession().cookies.get({ url });
  }

  async setCookie(cookie) {
    return this._getSession().cookies.set(cookie);
  }

  /**
   * Build default headers with session cookies and UA
   * @param {Object} [extraHeaders={}]
   * @returns {Promise<Object>}
   */
  async _buildHeaders(extraHeaders = {}, includeManualCookies = false) {
    const sess = this._getSession();
    const headers = {
      'User-Agent': sess.getUserAgent(),
      'Referer': 'https://demonicscans.org/',
      'Origin': 'https://demonicscans.org',
      ...extraHeaders,
    };
    // Injected transports used by unit tests do not own an Electron cookie
    // jar. Production session.fetch must manage cookies itself.
    if (includeManualCookies) headers.Cookie = await this._getCookieHeader();
    return headers;
  }

  /**
   * Perform a GET request
   * @param {string} url
   * @param {Object} [options={}]
   * @param {Object} [options.headers] - Extra headers
   * @param {number} [options.timeout] - Timeout in ms
   * @param {number} [options.retries] - Max retry attempts
   * @returns {Promise<HttpResponse>}
   */
  async get(url, options = {}) {
    return this._request('GET', url, null, options);
  }

  /**
   * Perform a read-only GET with selected cookie values changed for this
   * request only. Electron ignores an explicit Cookie header when credentials
   * are included, so this supplies the complete session cookie header while
   * using credentials=omit. The shared browser cookie jar is never mutated.
   */
  async getWithCookieOverrides(url, overrides, options = {}) {
    return this._request('GET', url, null, { ...options, cookieOverrides: { ...overrides } });
  }

  async _getCookieHeaderWithOverrides(url, overrides) {
    const entries = Object.entries(overrides || {});
    const overriddenNames = new Set(entries.map(([name]) => name));
    const cookies = await this._getSession().cookies.get({ url });
    const parts = cookies
      .filter(cookie => !overriddenNames.has(cookie.name))
      .map(cookie => `${cookie.name}=${cookie.value}`);
    for (const [name, value] of entries) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[;\r\n]/.test(String(value))) {
        throw new HttpClientError('Invalid request-scoped cookie override', 'INVALID_COOKIE_OVERRIDE');
      }
      parts.push(`${name}=${value}`);
    }
    return parts.join('; ');
  }

  /**
   * Perform a POST request with form-urlencoded body
   * @param {string} url
   * @param {URLSearchParams|string|Object} body
   * @param {Object} [options={}]
   * @returns {Promise<HttpResponse>}
   */
  async post(url, body, options = {}) {
    let bodyString;
    if (body instanceof URLSearchParams) {
      bodyString = body.toString();
    } else if (typeof body === 'object' && body !== null) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(body)) {
        params.set(key, String(value));
      }
      bodyString = params.toString();
    } else {
      bodyString = String(body || '');
    }

    const extraHeaders = {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(options.headers || {}),
    };

    return this._request('POST', url, bodyString, { ...options, headers: extraHeaders });
  }

  /**
   * Perform a POST request using browser-compatible multipart/form-data.
   * Fetch owns the Content-Type header so its generated boundary always
   * matches the encoded FormData body.
   * @param {string} url
   * @param {Object|FormData} fields
   * @param {Object} [options={}]
   * @returns {Promise<HttpResponse>}
   */
  async postMultipart(url, fields, options = {}) {
    const body = fields instanceof FormData ? fields : new FormData();
    if (!(fields instanceof FormData)) {
      for (const [key, value] of Object.entries(fields || {})) {
        body.append(key, String(value));
      }
    }

    const headers = Object.fromEntries(
      Object.entries(options.headers || {}).filter(([name]) => name.toLowerCase() !== 'content-type')
    );
    return this._request('POST', url, body, { ...options, headers });
  }

  /**
   * Core request method with retry logic
   * @param {string} method
   * @param {string} url
   * @param {string|FormData|null} body
   * @param {Object} options
   * @returns {Promise<HttpResponse>}
   */
  async _request(method, url, body, options = {}) {
    if (options.cookieOverrides && method !== 'GET') {
      throw new HttpClientError('Cookie overrides are restricted to read-only GET requests', 'INVALID_COOKIE_OVERRIDE');
    }
    const maxRetries = options.retries ?? (method === 'GET' ? this.maxRetries : 1);
    const timeout = options.timeout ?? this.defaultTimeout;
    let lastError = null;
    const requestGeneration = this.cancelGeneration;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const sess = this._getSession();
        const headers = await this._buildHeaders(options.headers || {}, Boolean(this.fetchImpl));
        if (options.cookieOverrides) {
          headers.Cookie = await this._getCookieHeaderWithOverrides(url, options.cookieOverrides);
        }
        const fetcher = this.fetchImpl || sess.fetch.bind(sess);

        const fetchOptions = {
          method,
          credentials: options.cookieOverrides ? 'omit' : 'include',
          headers,
        };
        if (body !== null && body !== undefined && method !== 'GET') {
          fetchOptions.body = body;
        }

        // Race between fetch and timeout
        const controller = new AbortController();
        this.activeControllers.add(controller);
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        let resp;
        try {
          resp = await fetcher(url, { ...fetchOptions, signal: controller.signal });
        } finally {
          clearTimeout(timeoutId);
          this.activeControllers.delete(controller);
        }

        const text = await resp.text();

        // Check for Cloudflare challenge
        if (text.includes('Just a moment...') || text.includes('Attention Required! | Cloudflare')) {
          throw new HttpClientError('Cloudflare challenge encountered', 'CLOUDFLARE', resp.status);
        }

        const trimmedText = text.trim();
        if ((/signin\.php/i.test(text) && /type=["']password["']/i.test(text)) ||
            /^access\s+denied[.!]?$/i.test(trimmedText)) {
          throw new HttpClientError('Game session is not authenticated', 'AUTH_REQUIRED', resp.status);
        }

        const response = new HttpResponse(resp.status, resp.ok, text, resp.headers);

        if (!resp.ok && attempt < maxRetries) {
          // Retry on server errors (5xx)
          if (resp.status >= 500) {
            const delay = this.baseRetryDelay * Math.pow(2, attempt - 1);
            Logger.logClient(this.accountName, `[HTTP] ${method} ${url} returned ${resp.status}, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
            await this._sleepRetry(delay);
            continue;
          }
        }

        return response;
      } catch (err) {
        lastError = err;

        if (requestGeneration !== this.cancelGeneration) {
          throw new HttpClientError('Request cancelled', 'CANCELLED');
        }

        if (err instanceof HttpClientError && ['CLOUDFLARE', 'AUTH_REQUIRED'].includes(err.code)) {
          // Challenges and expired authentication require user action, not retries.
          throw err;
        }

        if (err.name === 'AbortError') {
          lastError = new HttpClientError(`Request timed out after ${timeout}ms`, 'TIMEOUT');
        }

        if (attempt < maxRetries) {
          const delay = this.baseRetryDelay * Math.pow(2, attempt - 1);
          Logger.logClient(this.accountName, `[HTTP] ${method} ${url} failed: ${lastError.message}, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
          await this._sleepRetry(delay);
        }
      }
    }

    // All retries exhausted
    const errorMsg = lastError ? lastError.message : 'Unknown request error';
    Logger.logClient(this.accountName, `[HTTP] ${method} ${url} FAILED after ${maxRetries} attempts: ${errorMsg}`);
    throw lastError instanceof HttpClientError
      ? lastError
      : new HttpClientError(errorMsg, 'REQUEST_FAILED');
  }

  async _sleepRetry(baseDelay) {
    if (this.timingEngine) {
      await this.timingEngine.sleepRandom(baseDelay, Math.round(baseDelay * 1.5));
      return;
    }
    const delay = baseDelay + Math.floor(Math.random() * Math.max(1, Math.round(baseDelay * 0.5)));
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  cancelAll() {
    this.cancelGeneration++;
    for (const controller of this.activeControllers) controller.abort();
    this.activeControllers.clear();
  }
}

/**
 * Structured HTTP response
 */
class HttpResponse {
  /**
   * @param {number} status
   * @param {boolean} ok
   * @param {string} text
   * @param {Headers} headers
   */
  constructor(status, ok, text, headers) {
    this.status = status;
    this.ok = ok;
    this.text = text;
    this.headers = headers;
  }

  /**
   * Parse response text as JSON
   * @returns {Object|null}
   */
  json() {
    try {
      return JSON.parse(this.text);
    } catch {
      return null;
    }
  }

  /**
   * Check if response contains a specific string
   * @param {string} str
   * @returns {boolean}
   */
  includes(str) {
    return this.text.includes(str);
  }
}

/**
 * Custom error class for HTTP client errors
 */
class HttpClientError extends Error {
  /**
   * @param {string} message
   * @param {string} code - Error code: SESSION_DESTROYED, CLOUDFLARE, TIMEOUT, REQUEST_FAILED
   * @param {number} [status]
   */
  constructor(message, code, status = null) {
    super(message);
    this.name = 'HttpClientError';
    this.code = code;
    this.status = status;
  }
}

module.exports = { HttpClient, HttpResponse, HttpClientError };
