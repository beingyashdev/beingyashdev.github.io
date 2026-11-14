# Writing and publishing

Create a Markdown file in `src/content/blog/` for an article. The filename becomes the URL. Copy `templates/article.md` as a starting point; dates use `YYYY-MM-DD`. Categories and tags power Pagefind filters within Writing. All published articles appear on both Home and Writing. Notes and the other retired sections no longer have public routes; their remaining source files are not published.

Set `draft: true` while writing; drafts are excluded from routes, listings, RSS, sitemap, and search. Change it to `false` when ready. Set `sample: false` or remove it for your own writing. Code fences are syntax highlighted. Use a `mermaid` fence for a diagram; its source remains readable if rendering fails. MDX files also work.

Run `npm run check` and `npm run build`, then `npm run preview` to inspect the production output. Publishing happens only after you commit and push to the configured branch and enable GitHub Actions as the Pages source. Never put secrets in content or frontend configuration.
