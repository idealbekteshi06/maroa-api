'use strict';

/**
 * services/prompts/ai-seo/schema-builder.js
 * ----------------------------------------------------------------------------
 * JSON-LD schema generators per type. All deterministic — never invents fields.
 * If a required input is missing, the field is omitted (not nulled, not faked).
 *
 * Supported types:
 *   - Organization
 *   - LocalBusiness
 *   - WebSite
 *   - Product
 *   - FAQPage
 *   - HowTo
 *   - Person (founder)
 *   - BreadcrumbList
 *
 * All output is JSON-LD-valid and follows schema.org as of 2026.
 * ----------------------------------------------------------------------------
 */

const i18nSeo = require('./i18n-seo');

function defined(v) { return v !== undefined && v !== null && v !== ''; }

function buildOrganization({ business, sameAs = [] }) {
  const obj = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
  };
  if (defined(business?.business_name)) obj.name = business.business_name;
  if (defined(business?.website))       obj.url  = business.website;
  if (defined(business?.logo_url))      obj.logo = business.logo_url;
  if (defined(business?.tagline))       obj.description = business.tagline;
  if (Array.isArray(sameAs) && sameAs.length) obj.sameAs = sameAs.filter(Boolean);
  if (defined(business?.email) || defined(business?.phone)) {
    obj.contactPoint = {
      '@type': 'ContactPoint',
      contactType: 'customer service',
    };
    if (defined(business?.email)) obj.contactPoint.email = business.email;
    if (defined(business?.phone)) obj.contactPoint.telephone = business.phone;
  }
  return obj;
}

function buildLocalBusiness({ business, marketProfile }) {
  const country = marketProfile?.country || business?.country_code || business?.country;
  const fmt = country ? i18nSeo.ADDRESS_FORMATS[country] : null;

  const obj = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
  };
  if (defined(business?.business_name)) obj.name = business.business_name;
  if (defined(business?.website))       obj.url  = business.website;
  if (defined(business?.logo_url))      obj.image = business.logo_url;
  if (defined(business?.phone))         obj.telephone = business.phone;
  if (defined(business?.email))         obj.email = business.email;

  // Build address from whatever fields exist on the business profile.
  // Many SMBs only have a single-line "location" — fallback to that.
  if (business?.address || business?.location) {
    obj.address = {
      '@type': 'PostalAddress',
    };
    if (defined(business?.address?.streetAddress))   obj.address.streetAddress = business.address.streetAddress;
    if (defined(business?.address?.addressLocality)) obj.address.addressLocality = business.address.addressLocality;
    if (defined(business?.address?.addressRegion))   obj.address.addressRegion = business.address.addressRegion;
    if (defined(business?.address?.postalCode))      obj.address.postalCode = business.address.postalCode;
    if (defined(country))                            obj.address.addressCountry = country;
    // Fallback for SMBs with only a free-text location string.
    if (!obj.address.streetAddress && defined(business?.location)) {
      obj.address.streetAddress = business.location;
    }
  }

  if (defined(business?.business_hours) && typeof business.business_hours === 'object') {
    obj.openingHoursSpecification = formatHours(business.business_hours);
  }

  if (Number.isFinite(Number(business?.latitude)) && Number.isFinite(Number(business?.longitude))) {
    obj.geo = {
      '@type': 'GeoCoordinates',
      latitude: Number(business.latitude),
      longitude: Number(business.longitude),
    };
  }

  return obj;
}

function buildWebSite({ business }) {
  const obj = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
  };
  if (defined(business?.website))       obj.url = business.website;
  if (defined(business?.business_name)) obj.name = business.business_name;
  if (defined(business?.tagline))       obj.description = business.tagline;
  if (defined(business?.primary_language)) obj.inLanguage = business.primary_language;
  return obj;
}

function buildProduct({ product, business }) {
  if (!product) return null;
  const obj = {
    '@context': 'https://schema.org',
    '@type': 'Product',
  };
  if (defined(product.name))        obj.name = product.name;
  if (defined(product.description)) obj.description = product.description;
  if (defined(product.image))       obj.image = product.image;
  if (defined(product.sku))         obj.sku = product.sku;
  if (defined(business?.business_name)) {
    obj.brand = { '@type': 'Brand', name: business.business_name };
  }
  if (defined(product.price) && defined(product.currency)) {
    obj.offers = {
      '@type': 'Offer',
      price: product.price,
      priceCurrency: product.currency,
      availability: product.in_stock === false ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock',
    };
    if (defined(business?.website)) obj.offers.url = business.website;
  }
  return obj;
}

function buildFaqPage({ qaPairs }) {
  if (!Array.isArray(qaPairs) || qaPairs.length === 0) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: qaPairs
      .filter(qa => defined(qa?.question) && defined(qa?.answer))
      .map(qa => ({
        '@type': 'Question',
        name: qa.question,
        acceptedAnswer: { '@type': 'Answer', text: qa.answer },
      })),
  };
}

function buildHowTo({ name, steps, totalTime, supply, tool }) {
  if (!name || !Array.isArray(steps) || steps.length === 0) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name,
    ...(defined(totalTime) ? { totalTime } : {}),
    ...(Array.isArray(supply) && supply.length ? { supply: supply.map(s => ({ '@type': 'HowToSupply', name: s })) } : {}),
    ...(Array.isArray(tool) && tool.length ? { tool: tool.map(t => ({ '@type': 'HowToTool', name: t })) } : {}),
    step: steps.map((s, i) => ({
      '@type': 'HowToStep',
      position: i + 1,
      name: typeof s === 'string' ? `Step ${i + 1}` : (s.name || `Step ${i + 1}`),
      text: typeof s === 'string' ? s : s.text,
    })),
  };
}

function buildPerson({ name, jobTitle, image, sameAs = [] }) {
  if (!name) return null;
  const obj = {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name,
  };
  if (defined(jobTitle)) obj.jobTitle = jobTitle;
  if (defined(image))    obj.image = image;
  if (Array.isArray(sameAs) && sameAs.length) obj.sameAs = sameAs;
  return obj;
}

function buildBreadcrumbs({ items }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: it.url,
    })),
  };
}

function formatHours(hoursObj) {
  // hoursObj: { mon: '9-17', tue: '9-17', ... }  or { mon: { open: '09:00', close: '17:00' }, ...}
  const dayMap = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
  const out = [];
  for (const [k, v] of Object.entries(hoursObj || {})) {
    const day = dayMap[k.slice(0, 3).toLowerCase()];
    if (!day) continue;
    let opens, closes;
    if (typeof v === 'string') {
      const m = v.match(/(\d{1,2})(?::(\d{2}))?\s*[-–to]+\s*(\d{1,2})(?::(\d{2}))?/);
      if (m) {
        opens = `${m[1].padStart(2, '0')}:${(m[2] || '00').padStart(2, '0')}`;
        closes = `${m[3].padStart(2, '0')}:${(m[4] || '00').padStart(2, '0')}`;
      }
    } else if (v && typeof v === 'object') {
      opens = v.open;
      closes = v.close;
    }
    if (opens && closes) {
      out.push({ '@type': 'OpeningHoursSpecification', dayOfWeek: day, opens, closes });
    }
  }
  return out;
}

/**
 * Wrap a JSON-LD object in a <script> tag for embedding.
 */
function toScriptTag(obj) {
  return `<script type="application/ld+json">\n${JSON.stringify(obj, null, 2)}\n</script>`;
}

module.exports = {
  buildOrganization,
  buildLocalBusiness,
  buildWebSite,
  buildProduct,
  buildFaqPage,
  buildHowTo,
  buildPerson,
  buildBreadcrumbs,
  formatHours,
  toScriptTag,
};
