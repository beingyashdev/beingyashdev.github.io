import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
const common = { title: z.string(), category: z.string(), tags: z.array(z.string()), draft: z.boolean().default(false), sample: z.boolean().default(false) };
const blog = defineCollection({ loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/blog' }), schema: z.object({ ...common, description: z.string(), publishedDate: z.coerce.date(), updatedDate: z.coerce.date().optional(), featured: z.boolean().default(false), cover: z.string().optional() }) });
const notes = defineCollection({ loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/notes' }), schema: z.object({ ...common, date: z.coerce.date(), related: z.array(z.string()).default([]), references: z.array(z.object({ title: z.string(), url: z.string().url() })).default([]) }) });
export const collections = { blog, notes };
