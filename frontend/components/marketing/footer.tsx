import Link from 'next/link';
import { Logo } from './logo';

const FOOTER_NAV = {
  Product: [
    { href: '/features', label: 'Features' },
    { href: '/pricing', label: 'Pricing' },
    { href: '/changelog', label: 'Changelog' },
    { href: '/status', label: 'Status' },
  ],
  Company: [
    { href: '/about', label: 'About' },
    { href: '/blog', label: 'Blog' },
    { href: '/contact', label: 'Contact' },
  ],
  Legal: [
    { href: '/privacy', label: 'Privacy' },
    { href: '/terms', label: 'Terms' },
    { href: '/dpa', label: 'DPA' },
    { href: '/subprocessors', label: 'Subprocessors' },
  ],
};

export function Footer() {
  return (
    <footer className="mt-32 border-t border-ink-200/60 bg-ink-50">
      <div className="container py-16">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-10">
          <div className="col-span-2 md:col-span-1">
            <Logo />
            <p className="mt-4 text-sm text-ink-400 max-w-xs leading-relaxed">
              The marketing system for small businesses that knows your industry on day one.
            </p>
          </div>

          {Object.entries(FOOTER_NAV).map(([heading, links]) => (
            <div key={heading}>
              <h3 className="text-sm font-semibold text-ink-700">{heading}</h3>
              <ul className="mt-4 space-y-3">
                {links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-sm text-ink-400 hover:text-ink-700 transition-colors"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-16 pt-8 border-t border-ink-200/60 flex flex-col-reverse md:flex-row md:items-center md:justify-between gap-4">
          <p className="text-sm text-ink-400">
            © {new Date().getFullYear()} Maroa.ai. All rights reserved.
          </p>
          <p className="text-sm text-ink-400">
            Made for small businesses that move fast.
          </p>
        </div>
      </div>
    </footer>
  );
}
