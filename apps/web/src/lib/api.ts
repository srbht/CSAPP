/**
 * API client. The short-lived access token lives only in memory (never localStorage);
 * the refresh token is an httpOnly cookie the browser sends to /api/v1/auth/refresh.
 * On a 401 the client refreshes once and retries the request.
 */
export interface FieldError {
  path: string;
  code: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public errors: FieldError[] = [],
  ) {
    super(message);
  }
}

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onSessionExpired: (() => void) | null = null;

export const setAccessToken = (t: string | null) => {
  accessToken = t;
};
export const setSessionExpiredHandler = (fn: () => void) => {
  onSessionExpired = fn;
};

export async function refreshSession(): Promise<boolean> {
  refreshing ??= fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'same-origin' })
    .then(async (r) => {
      if (!r.ok) return false;
      setAccessToken((await r.json()).accessToken);
      return true;
    })
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

async function parseError(res: Response): Promise<ApiError> {
  try {
    const body = await res.json();
    return new ApiError(res.status, body.code ?? `HTTP_${res.status}`, body.detail ?? res.statusText, body.errors ?? []);
  } catch {
    return new ApiError(res.status, `HTTP_${res.status}`, res.status >= 500 ? 'Server error. Please try again.' : res.statusText);
  }
}

type Body = object | FormData | undefined;

async function request<T>(method: string, url: string, body?: Body, retry = true): Promise<T> {
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const isForm = body instanceof FormData;
  if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`/api/v1${url}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your internet connection.');
  }
  if (res.status === 401 && retry && !url.startsWith('/auth/')) {
    if (await refreshSession()) return request<T>(method, url, body, false);
    onSessionExpired?.();
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  return (type.includes('json') ? res.json() : res.blob()) as Promise<T>;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: Body) => request<T>('POST', url, body ?? {}),
  patch: <T>(url: string, body: Body) => request<T>('PATCH', url, body),
  put: <T>(url: string, body: Body) => request<T>('PUT', url, body),
  delete: <T>(url: string) => request<T>('DELETE', url),
};

/** Build a query string, skipping empty values. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export interface Page<T> {
  data: T[];
  meta: { page: number; pageSize: number; total: number };
}
