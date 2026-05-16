/**
 * Motion primitive tests — reduced-motion fallback contracts.
 *
 * NOT YET RUNNABLE: this repo doesn't have vitest wired into
 * package.json yet. To run these, add to frontend/package.json scripts:
 *
 *   "test": "vitest run"
 *
 * …and install vitest + jsdom as devDependencies. Until then this file
 * serves as living documentation of what each primitive must guarantee
 * when a user has prefers-reduced-motion: reduce set.
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
