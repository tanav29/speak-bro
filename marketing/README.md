# SpeakBro marketing site

A standalone Vite + React landing page. The demo video is embedded from YouTube with privacy-enhanced mode.

## Build

```bash
cd marketing
npm run build
```

The deployable output is generated in `marketing/dist/` and contains optimized static HTML, CSS, and JavaScript.

## Deploy

Point a static host at `marketing/dist`:

- **Vercel:** `cd marketing && vercel --prod` (set output directory to `dist` if prompted)
- **Netlify:** publish directory `marketing/dist`
- **GitHub Pages:** publish the contents of `marketing/dist`
- **Cloudflare Pages:** build command `npm run build`, output directory `dist`

No environment variables or backend are required for the marketing page. The setup section links visitors to the main project README for running SpeakBro itself.
