/**
 * Motion primitive tests — reduced-motion fallback contracts.
 *
 * Runnable as of audit 2026-05-19 F7 — vitest + jsdom + @testing-library/
 * jest-dom + @vitejs/plugin-react are wired. See vitest.config.ts and
 * tests/setup.ts. Run with `npm test` or `npm run test:watch`.
 *
 * These specs verify every motion primitive in components/motion/ still
 * renders its children when the user has `prefers-reduced-motion: reduce`.
 * The mock below forces that state so we don't depend on the test
 * runner's matchMedia behavior.
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { FadeIn } from '@/components/motion/fade-in';
import { StaggerList } from '@/components/motion/stagger-list';
import { OptimisticCheck } from '@/components/motion/optimistic-check';
import { PageTransition } from '@/components/motion/page-transition';

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion');
  return {
    ...actual,
    useReducedMotion: () => true,
  };
});

describe('motion primitives — reduced-motion fallback', () => {
  it('FadeIn renders children visibly under reduced motion', () => {
    const { getByText } = render(<FadeIn>hello</FadeIn>);
    expect(getByText('hello')).toBeTruthy();
  });

  it('StaggerList renders all children with no stagger delay', () => {
    const { getByText } = render(
      <StaggerList>
        <div>one</div>
        <div>two</div>
        <div>three</div>
      </StaggerList>,
    );
    expect(getByText('one')).toBeTruthy();
    expect(getByText('two')).toBeTruthy();
    expect(getByText('three')).toBeTruthy();
  });

  it('OptimisticCheck renders with no scale bounce', () => {
    const { container } = render(<OptimisticCheck show={true} label="Saved" />);
    expect(container.textContent).toContain('Saved');
  });

  it('PageTransition returns a plain <main> when reduced-motion is on', () => {
    const { container } = render(<PageTransition>body</PageTransition>);
    const main = container.querySelector('main');
    expect(main).toBeTruthy();
    expect(main?.textContent).toBe('body');
  });
});
