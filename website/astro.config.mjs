// @ts-check
import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'
import tailwindcss from '@tailwindcss/vite'

// Clawboo brand site. Static output, no SSR adapter, deployable to Cloudflare
// Pages by building only this subdir (Root directory = website).
const SITE = 'https://www.claw.boo'

export default defineConfig({
  site: SITE,
  output: 'static',
  integrations: [
    // No React integration: every island (the sky, the drifting mascots, the Boo
    // squad) is gone, so the site ships zero client-side framework code.
    sitemap({
      // Freshness/priority hints. lastmod is a fixed calendar date, not the wall
      // clock (`new Date()` with no args), so every build stays byte-deterministic;
      // a moving lastmod churns the sitemap each deploy and reads as spam. Bump on
      // release.
      changefreq: 'monthly',
      priority: 0.7,
      lastmod: new Date('2026-07-20'),
      serialize(item) {
        // Only two pages today. Match exact URLs so any new page falls back to the
        // sensible global defaults above rather than inheriting homepage weight.
        if (item.url === `${SITE}/`) {
          item.priority = 1.0
          item.changefreq = 'weekly'
        } else if (item.url === `${SITE}/privacy/`) {
          item.priority = 0.3
          item.changefreq = 'yearly'
          item.lastmod = '2026-06-27' // matches privacy.astro "Last updated"
        }
        return item
      },
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
  image: {
    // Default Sharp service. Screenshots imported from src/assets are emitted
    // as responsive avif/webp with content hashes.
  },
})
