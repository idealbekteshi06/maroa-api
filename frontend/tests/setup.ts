import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Unmount any rendered DOM after each test so state doesn't bleed between
// tests. React Testing Library v16 needs this to be wired explicitly.
afterEach(() => {
  cleanup();
});
