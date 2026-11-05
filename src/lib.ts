import { getCollection } from 'astro:content';
export const publishedBlog = async () => (await getCollection('blog', ({ data }) => !data.draft)).sort((a,b) => b.data.publishedDate.valueOf() - a.data.publishedDate.valueOf());
export const publishedNotes = async () => (await getCollection('notes', ({ data }) => !data.draft)).sort((a,b) => b.data.date.valueOf() - a.data.date.valueOf());
export const date = (d: Date) => d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
export const readingTime = (body = '') => Math.max(1, Math.ceil(body.trim().split(/\s+/).length / 220));
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
