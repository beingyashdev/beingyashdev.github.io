# Writing and publishing

Create a Markdown file in `src/content/notes/` for a short discovery or `src/content/blog/` for a longer article. The filename becomes the URL. Copy a starting point from `templates/`; dates use `YYYY-MM-DD`. Categories and tags power the knowledge explorer and Pagefind filters. Related article IDs are filenames without the extension. References are optional title/URL pairs.

Set `draft: true` while writing; drafts are excluded from routes, listings, RSS, sitemap, and search. Change it to `false` when ready. Set `sample: false` or remove it for your own writing. Code fences are syntax highlighted. Use a `mermaid` fence for a diagram; its source remains readable if rendering fails. MDX files also work.

Run `npm run check` and `npm run build`, then `npm run preview` to inspect the production output. Publishing happens only after you commit and push to the configured branch and enable GitHub Actions as the Pages source. Never put secrets in content or frontend configuration.
