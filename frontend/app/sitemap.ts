import type { MetadataRoute } from 'next';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://maroa.ai';

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return [
    { url: `${SITE_URL}/`, lastModified, changeFrequency: 'weekly', priority: 1.0 },
    { url: `${SITE_URL}/features`, lastModified, changeFrequency: 'monthly', priority: 0.9 },
    { url: `${SITE_URL}/pricing`, lastModified, changeFrequency: 'monthly', priority: 0.9 },
    // Vertical landing pages — high SEO value
    { url: `${SITE_URL}/for-agencies`, lastModified, changeFrequency: 'monthly', priority: 0.9 },
    { url: `${SITE_URL}/for-freelancers`, lastModified, changeFrequency: 'monthly', priority: 0.9 },
    { url: `${SITE_URL}/about`, lastModified, changeFrequency: 'monthly', priority: 0.7 },
    { url: `${SITE_URL}/blog`, lastModified, changeFrequency: 'weekly', priority: 0.7 },
    { url: `${SITE_URL}/changelog`, lastModified, changeFrequency: 'weekly', priority: 0.6 },
    { url: `${SITE_URL}/contact`, lastModified, changeFrequency: 'yearly', priority: 0.6 },
    { url: `${SITE_URL}/status`, lastModified, changeFrequency: 'daily', priority: 0.4 },
    // Legal
    { url: `${SITE_URL}/privacy`, lastModified, changeFrequency: 'yearly', priority: 0.4 },
    { url: `${SITE_URL}/terms`, lastModified, changeFrequency: 'yearly', priority: 0.4 },
    { url: `${SITE_URL}/dpa`, lastModified, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${SITE_URL}/subprocessors`, lastModified, changeFrequency: 'monthly', priority: 0.3 },
    // Auth surfaces (low-priority but indexable)
    { url: `${SITE_URL}/login`, lastModified, changeFrequency: 'yearly', priority: 0.5 },
    { url: `${SITE_URL}/signup`, lastModified, changeFrequency: 'yearly', priority: 0.8 },
  ];
}
