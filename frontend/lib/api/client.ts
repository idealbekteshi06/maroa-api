/**
 * lib/api/client.ts — typed fetch wrapper for the Maroa backend.
 *
 * - Base URL from NEXT_PUBLIC_API_URL
 * - Adds Authorization: Bearer <jwt> from Supabase session
 * - Adds request-id for distributed tracing
 * - Throws typed ApiError on non-2xx so callers can catch + branch
 */

import { getSession } from './auth';
import { pickString } from '../errors';

const API_URL =
  process.env.NEXT_PUBLIC_API_URL || 'https://maroa-api-production.up.railway.app';

export class ApiError extends Error {
  status: number;
  body?: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
    this.name = 'ApiError';
  }
}

type RequestInitX = Omit<RequestInit, 'body'> & { body?: unknown };

export async function apiFetch<T = unknown>(path: string, init: RequestInitX = {}): Promise<T> {
  const headers = new Headers(init.headers as HeadersInit | undefined);
  headers.set('Accept', 'application/json');
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json');

  // Attach Supabase JWT if user is signed in
  try {
    const session = await getSession();
    if (session?.access_token) {
      headers.set('Authorization', `Bearer ${session.access_token}`);
    }
  } catch {
    // no session — anonymous request
  }

  // Request ID for tracing
  if (!headers.has('x-request-id') && typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    headers.set('x-request-id', crypto.randomUUID());
  }

  const url = `${API_URL.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
  const body =
    init.body !== undefined && typeof init.body !== 'string'
      ? JSON.stringify(init.body)
      : (init.body as string | undefined);

  const res = await fetch(url, { ...init, headers, body });

  let parsed: unknown = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) parsed = await res.json().catch(() => null);
  else parsed = await res.text().catch(() => null);

  if (!res.ok) {
    // Audit 2026-05-19 F27: was `(parsed as any)?.message` — replaced with
    // a type-safe pick that returns undefined when the field isn't a string.
    const message =
      pickString(parsed, 'message') ||
      pickString(parsed, 'error') ||
      `${res.status} ${res.statusText}`;
    throw new ApiError(message, res.status, parsed);
  }
  return parsed as T;
}

export const api = {
  get: <T = unknown>(path: string, init?: RequestInitX) =>
    apiFetch<T>(path, { ...init, method: 'GET' }),
  post: <T = unknown>(path: string, body?: unknown, init?: RequestInitX) =>
    apiFetch<T>(path, { ...init, method: 'POST', body }),
  put: <T = unknown>(path: string, body?: unknown, init?: RequestInitX) =>
    apiFetch<T>(path, { ...init, method: 'PUT', body }),
  patch: <T = unknown>(path: string, body?: unknown, init?: RequestInitX) =>
    apiFetch<T>(path, { ...init, method: 'PATCH', body }),
  delete: <T = unknown>(path: string, init?: RequestInitX) =>
    apiFetch<T>(path, { ...init, method: 'DELETE' }),
};
