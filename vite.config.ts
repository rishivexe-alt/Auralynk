import { defineConfig } from 'vite'

// Relative base so the production bundle runs from any path:
// localhost root, a GitHub Pages project site (https://user.github.io/repo/),
// Vercel, Netlify, or any static host — with no repository-name
// assumptions baked in. Dev-server behavior is unchanged.
export default defineConfig({
  base: './',
})
