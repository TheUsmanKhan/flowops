/** Frontend fetch helpers with typed responses and error handling. */

export class FetchError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * The localStorage key where the session token is stored after login.
 * This token is sent as `Authorization: Bearer <token>` on every request,
 * which works in ALL contexts (iframes, cross-origin, preview panels, mobile)
 * unlike cookies which are blocked by SameSite/HttpOnly/cross-origin rules.
 */
const SESSION_TOKEN_KEY = 'flowops_session_token'

/** Store the session token in localStorage (called after login/register). */
export function setSessionToken(token: string) {
  if (typeof window !== 'undefined') {
    localStorage.setItem(SESSION_TOKEN_KEY, token)
  }
}

/** Clear the session token from localStorage (called after logout). */
export function clearSessionToken() {
  if (typeof window !== 'undefined') {
    localStorage.removeItem(SESSION_TOKEN_KEY)
  }
}

/** Get the session token from localStorage. */
export function getSessionToken(): string | null {
  if (typeof window !== 'undefined') {
    return localStorage.getItem(SESSION_TOKEN_KEY)
  }
  return null
}

/**
 * Centralized fetch wrapper.
 *
 * Sends the session token via `Authorization: Bearer <token>` header (from
 * localStorage) AND includes credentials for cookie-based fallback.
 *
 * This dual-channel approach ensures auth works in ALL contexts:
 *   - Same-origin (cookie works)
 *   - Cross-origin / iframe / preview panel (Bearer token works)
 *   - Mobile app (Bearer token works)
 */
async function request<T>(
  url: string,
  options?: RequestInit,
): Promise<T> {
  const token = getSessionToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string> ?? {}),
  }
  // Attach Bearer token if available
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const res = await fetch(url, {
    ...options,
    credentials: 'include',
    headers,
    cache: 'no-store',
  })
  let body: unknown = null
  const text = await res.text()
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : typeof body === 'string'
          ? body
          : 'Request failed'
    throw new FetchError(res.status, message)
  }
  return body as T
}

export const api = {
  get: <T>(url: string) => request<T>(url, { method: 'GET' }),
  post: <T>(url: string, data?: unknown) =>
    request<T>(url, { method: 'POST', body: data ? JSON.stringify(data) : undefined }),
  put: <T>(url: string, data?: unknown) =>
    request<T>(url, { method: 'PUT', body: data ? JSON.stringify(data) : undefined }),
  patch: <T>(url: string, data?: unknown) =>
    request<T>(url, { method: 'PATCH', body: data ? JSON.stringify(data) : undefined }),
  delete: <T>(url: string) => request<T>(url, { method: 'DELETE' }),
}

export function initials(name: string): string {
  return name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
}
