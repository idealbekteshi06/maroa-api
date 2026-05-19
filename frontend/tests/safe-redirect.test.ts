import { describe, it, expect } from 'vitest';
import { safeRedirectPath, DEFAULT_REDIRECT } from '@/lib/safe-redirect';

describe('safeRedirectPath — open-redirect defense', () => {
  it('returns DEFAULT for null/empty/undefined input', () => {
    expect(safeRedirectPath(null)).toBe(DEFAULT_REDIRECT);
    expect(safeRedirectPath(undefined)).toBe(DEFAULT_REDIRECT);
    expect(safeRedirectPath('')).toBe(DEFAULT_REDIRECT);
  });

  it('returns DEFAULT for absolute URLs', () => {
    expect(safeRedirectPath('https://attacker.example')).toBe(DEFAULT_REDIRECT);
    expect(safeRedirectPath('http://maroa.ai/dashboard')).toBe(DEFAULT_REDIRECT);
    expect(safeRedirectPath('ftp://x')).toBe(DEFAULT_REDIRECT);
  });

  it('returns DEFAULT for protocol-relative URLs', () => {
    expect(safeRedirectPath('//attacker.example')).toBe(DEFAULT_REDIRECT);
    expect(safeRedirectPath('//attacker.example/dashboard')).toBe(DEFAULT_REDIRECT);
  });

  it('returns DEFAULT for javascript:/data: schemes', () => {
    expect(safeRedirectPath('javascript:alert(1)')).toBe(DEFAULT_REDIRECT);
    expect(safeRedirectPath('data:text/html,...')).toBe(DEFAULT_REDIRECT);
  });

  it('returns DEFAULT for backslash-escaped variants', () => {
    expect(safeRedirectPath('/\\attacker.example')).toBe(DEFAULT_REDIRECT);
  });

  it('returns DEFAULT for paths outside the allowlist', () => {
    expect(safeRedirectPath('/login')).toBe(DEFAULT_REDIRECT);
    expect(safeRedirectPath('/signup')).toBe(DEFAULT_REDIRECT);
    expect(safeRedirectPath('/admin/users')).toBe(DEFAULT_REDIRECT);
  });

  it('accepts allowlisted paths', () => {
    expect(safeRedirectPath('/dashboard')).toBe('/dashboard');
    expect(safeRedirectPath('/dashboard/clients')).toBe('/dashboard/clients');
    expect(safeRedirectPath('/content')).toBe('/content');
    expect(safeRedirectPath('/ads')).toBe('/ads');
    expect(safeRedirectPath('/settings')).toBe('/settings');
    expect(safeRedirectPath('/onboarding')).toBe('/onboarding');
  });

  it('preserves query strings on allowlisted paths', () => {
    expect(safeRedirectPath('/dashboard?tab=approvals')).toBe('/dashboard?tab=approvals');
    expect(safeRedirectPath('/content?status=draft')).toBe('/content?status=draft');
  });
});
