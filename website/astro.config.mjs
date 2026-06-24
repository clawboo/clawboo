// @ts-check
import { defineConfig } from 'astro/config'
import react from '@astrojs/react'
import sitemap from '@astrojs/sitemap'
import tailwindcss from '@tailwindcss/vite'

// Clawboo brand site. Static output, no SSR adapter, deployable to Cloudflare
// Pages by building only this subdir (Root directory = website).
export default defineConfig({
  site: 'https://www.claw.boo',
  output: 'static',
  integrations: [react(), sitemap()],
  vite: {
    plugins: [tailwindcss()],
  },
  image: {
    // Default Sharp service. Screenshots imported from src/assets are emitted
    // as responsive avif/webp with content hashes.
  },
})
