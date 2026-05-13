'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Menu, X } from 'lucide-react';
import { Logo } from './logo';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

const NAV_LINKS = [
  { href: '/features', label: 'Features' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/about', label: 'About' },
];

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Lock body scroll when mobile menu open
  useEffect(() => {
    document.body.style.overflow = mobileOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [mobileOpen]);

  return (
    <header
      className={cn(
        'sticky top-0 z-40 w-full transition-all duration-300',
        scrolled ? 'border-b border-ink-200/60 bg-white/80 backdrop-blur-xl' : 'bg-transparent',
      )}
    >
      <div className="container flex h-16 items-center justify-between">
        <Logo />

        {/* Desktop nav */}
        <nav className="hidden md:flex items-center gap-1" aria-label="Primary">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="px-4 py-2 text-sm font-medium text-ink-700 hover:text-ink-900 hover:bg-ink-100 rounded-full transition-colors"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="hidden md:flex items-center gap-2">
          <Button href="/login" variant="ghost" size="sm">
            Log in
          </Button>
          <Button href="/signup" variant="primary" size="sm">
            Start free
          </Button>
        </div>

        {/* Mobile trigger */}
        <button
          type="button"
          onClick={() => setMobileOpen((o) => !o)}
          className="md:hidden p-2 -mr-2 text-ink-700 hover:bg-ink-100 rounded-full transition-colors"
          aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={mobileOpen}
        >
          {mobileOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
        </button>
      </div>

      {/* Mobile menu sheet */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 top-16 bg-white animate-fade-in">
          <nav className="container flex flex-col py-6 gap-1" aria-label="Mobile">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMobileOpen(false)}
                className="px-4 py-3 text-lg font-medium text-ink-700 hover:bg-ink-100 rounded-xl transition-colors"
              >
                {link.label}
              </Link>
            ))}
            <div className="mt-4 flex flex-col gap-3 px-4">
              <Button href="/login" variant="outline" size="lg" onClick={() => setMobileOpen(false)}>
                Log in
              </Button>
              <Button href="/signup" variant="primary" size="lg" onClick={() => setMobileOpen(false)}>
                Start free
              </Button>
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
