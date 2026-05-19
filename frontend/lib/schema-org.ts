/**
 * lib/schema-org.ts
 * ---------------------------------------------------------------------------
 * Schema.org JSON-LD builders for Maroa marketing pages.
 *
 * Why this exists: rich snippets (Google) and AI-search citations
 * (Claude/Perplexity/ChatGPT) are dramatically more likely when pages
 * ship structured data. The prior site had Organization schema in
 * app/layout.tsx but nothing else — so /pricing wasn't eligible for
 * Google's product rich result and the FAQ wasn't eligible for the FAQ
 * carousel. This module is the single source of truth for the schemas
 * we ship; pages render them via <Script type="application/ld+json">
 * or a `<script dangerouslySetInnerHTML>`.
 *
 * Audit 2026-05-19 F18 + F19.
 * ---------------------------------------------------------------------------
 */

export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://maroa.ai';

interface SoftwareApplicationOpts {
  url?: string;
  description?: string;
}

/**
 * SoftwareApplication schema for the homepage + product pages.
 * Includes an AggregateOffer with the two public plans so Google's
 * Product/Offer rich snippet has the data it needs.
 */
export function softwareApplicationSchema(opts: SoftwareApplicationOpts = {}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Maroa',
    applicationCategory: 'BusinessApplication',
    applicationSubCategory: 'Marketing Automation',
    operatingSystem: 'Web',
    description:
      opts.description ||
      'AI marketing operating system for freelancers, agencies, and SMBs. Runs content, ads, CRO, SEO, and reporting across every client with a full reasoning trace.',
    url: opts.url || SITE_URL,
    image: `${SITE_URL}/opengraph-image`,
    offers: {
      '@type': 'AggregateOffer',
      priceCurrency: 'USD',
      lowPrice: '149',
      highPrice: '599',
      offerCount: 2,
      offers: [
        {
          '@type': 'Offer',
          name: 'Growth',
          price: '149',
          priceCurrency: 'USD',
          url: `${SITE_URL}/pricing`,
          availability: 'https://schema.org/InStock',
          priceSpecification: {
            '@type': 'UnitPriceSpecification',
            price: '149',
            priceCurrency: 'USD',
            referenceQuantity: { '@type': 'QuantitativeValue', value: 1, unitCode: 'MON' },
          },
        },
        {
          '@type': 'Offer',
          name: 'Agency',
          price: '599',
          priceCurrency: 'USD',
          url: `${SITE_URL}/pricing`,
          availability: 'https://schema.org/InStock',
          priceSpecification: {
            '@type': 'UnitPriceSpecification',
            price: '599',
            priceCurrency: 'USD',
            referenceQuantity: { '@type': 'QuantitativeValue', value: 1, unitCode: 'MON' },
          },
        },
      ],
    },
    publisher: {
      '@type': 'Organization',
      name: 'Maroa',
      url: SITE_URL,
    },
  };
}

interface FaqEntry {
  question: string;
  answer: string;
}

export function faqPageSchema(entries: FaqEntry[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: entries.map((e) => ({
      '@type': 'Question',
      name: e.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: e.answer,
      },
    })),
  };
}

interface BreadcrumbItem {
  name: string;
  url: string;
}

export function breadcrumbSchema(items: BreadcrumbItem[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, idx) => ({
      '@type': 'ListItem',
      position: idx + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

/**
 * Serialize a schema object to a string suitable for
 * `<script type="application/ld+json" dangerouslySetInnerHTML={...} />`.
 * Strips XSS-relevant characters from the JSON body itself.
 */
export function ldJson(schema: object): string {
  return JSON.stringify(schema).replace(/</g, '\\u003c');
}
