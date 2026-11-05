import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({ site: 'https://beingyashdev.github.io', base: '/', integrations: [mdx(), sitemap()], vite: { plugins: [tailwindcss()], environments: { astro: { optimizeDeps: { include: ['yaml', 'picomatch'] } } } }, markdown: { shikiConfig: { themes: { light: 'github-light', dark: 'github-dark' }, wrap: false } } });
