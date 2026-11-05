import rss from '@astrojs/rss'; import {publishedBlog} from '../lib'; import {site} from '../config';
export async function GET(context: any){return rss({title:site.name,description:site.description,site:context.site,items:(await publishedBlog()).map(p=>({title:p.data.title,description:p.data.description,pubDate:p.data.publishedDate,link:`/blog/${p.id}/`}))})}
