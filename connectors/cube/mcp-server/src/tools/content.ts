import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toolError } from '@ai-fund/lib/tool-errors';

type ArticleRecord = {
  source: string;
  url: string;
  title: string | null;
  author: string | null;
  publishedAt: string | null;
};

type FeedSource = {
  name: string;
  url: string;
  kind: 'news' | 'reddit' | 'x';
};

const CUBE_SITEMAP_URL = 'https://cube.exchange/sitemap.xml';
const DEFAULT_MAX_ARTICLES = 200;
const DEFAULT_MAX_SITEMAPS = 25;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_CUBE_CONCURRENCY = 4;

const EXTERNAL_RSS_FEEDS: FeedSource[] = [
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', kind: 'news' },
  { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss', kind: 'news' },
  { name: 'The Block', url: 'https://www.theblock.co/rss.xml', kind: 'news' },
  { name: 'Decrypt', url: 'https://decrypt.co/feed', kind: 'news' },
];

const REDDIT_FEEDS: FeedSource[] = [
  { name: 'Reddit r/CryptoCurrency', url: 'https://www.reddit.com/r/CryptoCurrency/new/.rss', kind: 'reddit' },
  { name: 'Reddit r/Bitcoin', url: 'https://www.reddit.com/r/Bitcoin/new/.rss', kind: 'reddit' },
  { name: 'Reddit r/ethfinance', url: 'https://www.reddit.com/r/ethfinance/new/.rss', kind: 'reddit' },
];

const X_FEEDS: FeedSource[] = [
  { name: 'X @cubeexchange', url: 'https://nitter.net/cubeexchange/rss', kind: 'x' },
  { name: 'X @coindesk', url: 'https://nitter.net/coindesk/rss', kind: 'x' },
];


function stripCdata(value: string): string {
  return value.replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim();
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function cleanText(value: string): string {
  return decodeXmlEntities(stripCdata(value));
}

function extractTags(xml: string, tag: string): string[] {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const values: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    values.push(cleanText(match[1]));
  }
  return values;
}

function extractFirstTag(xml: string, tag: string): string | null {
  return extractTags(xml, tag)[0] ?? null;
}

function isCubeHost(hostname: string): boolean {
  return hostname === 'cube.exchange' || hostname === 'www.cube.exchange';
}

function normalizeUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  parsed.hash = '';
  return parsed.toString();
}

function looksLikeArticlePath(url: string): boolean {
  const { pathname } = new URL(url);
  if (/(^|\/)sitemap(-|\.|$)/i.test(pathname)) return false;
  if (/\.(xml|jpg|jpeg|png|webp|gif|svg|js|css|ico)$/i.test(pathname)) return false;

  const articleHints = ['/what-is/', '/news/', '/blog/', '/learn/', '/academy/', '/research/', '/articles/'];
  return articleHints.some(hint => pathname.startsWith(hint) || pathname.includes(hint));
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'ai-fund-cube-mcp/0.1 content-discovery',
        accept: 'application/xml,text/xml,application/atom+xml,application/rss+xml,text/html;q=0.9,*/*;q=0.8',
      },
    });

    if (!response.ok) {
      throw new Error(`Request failed (${response.status}) for ${url}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function crawlCubeArticleUrls(
  rootSitemapUrl: string,
  maxSitemaps: number,
  maxArticles: number,
  timeoutMs: number,
): Promise<string[]> {
  const queue = [rootSitemapUrl];
  const visited = new Set<string>();
  const articleUrls = new Set<string>();

  while (queue.length > 0 && visited.size < maxSitemaps && articleUrls.size < maxArticles) {
    const sitemapUrl = queue.shift();
    if (!sitemapUrl || visited.has(sitemapUrl)) continue;
    visited.add(sitemapUrl);

    const xml = await fetchText(sitemapUrl, timeoutMs);
    const locValues = extractTags(xml, 'loc');

    const nestedSitemaps = locValues.filter(loc => {
      try {
        const parsed = new URL(loc);
        return isCubeHost(parsed.hostname) && parsed.pathname.endsWith('.xml');
      } catch {
        return false;
      }
    });

    if (nestedSitemaps.length > 0 && /<sitemapindex/i.test(xml)) {
      for (const nested of nestedSitemaps) {
        if (!visited.has(nested)) queue.push(nested);
      }
      continue;
    }

    for (const loc of locValues) {
      if (articleUrls.size >= maxArticles) break;
      try {
        const normalized = normalizeUrl(loc);
        const parsed = new URL(normalized);
        if (!isCubeHost(parsed.hostname) || parsed.protocol !== 'https:') continue;
        if (!looksLikeArticlePath(normalized)) continue;
        articleUrls.add(normalized);
      } catch {
        // Ignore invalid URL entries.
      }
    }
  }

  return Array.from(articleUrls);
}

function pickMeta(html: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) return cleanText(match[1]);
  }
  return null;
}

async function fetchCubeArticleMetadata(url: string, timeoutMs: number): Promise<ArticleRecord> {
  const html = await fetchText(url, timeoutMs);

  return {
    source: 'cube.exchange',
    url,
    title: pickMeta(html, [
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i,
      /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["'][^>]*>/i,
      /<title[^>]*>([^<]+)<\/title>/i,
    ]),
    author: pickMeta(html, [
      /<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["'][^>]*>/i,
      /<meta[^>]+property=["']article:author["'][^>]+content=["']([^"']+)["'][^>]*>/i,
      /"author"\s*:\s*\{\s*"name"\s*:\s*"([^"]+)"/i,
    ]),
    publishedAt: pickMeta(html, [
      /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["'][^>]*>/i,
      /<meta[^>]+name=["']date["'][^>]+content=["']([^"']+)["'][^>]*>/i,
      /<time[^>]+datetime=["']([^"']+)["'][^>]*>/i,
    ]),
  };
}

function parseRssOrAtomFeed(xml: string, sourceName: string, maxItems: number): ArticleRecord[] {
  const records: ArticleRecord[] = [];

  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
  if (items.length > 0) {
    for (const item of items.slice(0, maxItems)) {
      const url = extractFirstTag(item, 'link');
      if (!url) continue;

      records.push({
        source: sourceName,
        url: normalizeUrl(url),
        title: extractFirstTag(item, 'title'),
        author: extractFirstTag(item, 'author') ?? extractFirstTag(item, 'dc:creator'),
        publishedAt: extractFirstTag(item, 'pubDate'),
      });
    }
    return records;
  }

  const entries = xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? [];
  for (const entry of entries.slice(0, maxItems)) {
    const directLink = extractFirstTag(entry, 'link');
    const hrefLink = (() => {
      const match = entry.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);
      return match?.[1] ? cleanText(match[1]) : null;
    })();

    const url = hrefLink ?? directLink;
    if (!url) continue;

    records.push({
      source: sourceName,
      url: normalizeUrl(url),
      title: extractFirstTag(entry, 'title'),
      author: extractFirstTag(entry, 'name') ?? extractFirstTag(entry, 'author'),
      publishedAt: extractFirstTag(entry, 'updated') ?? extractFirstTag(entry, 'published'),
    });
  }

  return records;
}

function parseDateMs(dateStr: string | null): number {
  if (!dateStr) return 0;
  const ms = Date.parse(dateStr);
  return Number.isFinite(ms) ? ms : 0;
}

function sortByPublishedDateDesc(records: ArticleRecord[]): ArticleRecord[] {
  return [...records].sort((a, b) => parseDateMs(b.publishedAt) - parseDateMs(a.publishedAt));
}


function getFallbackFeeds(includeSocial: boolean): FeedSource[] {
  if (!includeSocial) return EXTERNAL_RSS_FEEDS;
  return [...EXTERNAL_RSS_FEEDS, ...REDDIT_FEEDS, ...X_FEEDS];
}

async function fetchExternalRssArticles(limit: number, timeoutMs: number, seenUrls: Set<string>, includeSocial: boolean): Promise<ArticleRecord[]> {
  if (limit <= 0) return [];

  const feeds = getFallbackFeeds(includeSocial);
  const perFeed = Math.max(1, Math.ceil(limit / feeds.length));
  const collected: ArticleRecord[] = [];

  for (const feed of feeds) {
    if (collected.length >= limit) break;

    try {
      const xml = await fetchText(feed.url, timeoutMs);
      const items = parseRssOrAtomFeed(xml, feed.name, perFeed);
      for (const item of items) {
        if (seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
        collected.push(item);
        if (collected.length >= limit) break;
      }
    } catch {
      // best effort only
    }
  }

  return sortByPublishedDateDesc(collected);
}

async function fetchCubeMetadataBatch(urls: string[], timeoutMs: number, concurrency: number): Promise<ArticleRecord[]> {
  const out: ArticleRecord[] = [];

  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map(url => fetchCubeArticleMetadata(url, timeoutMs)));

    for (let j = 0; j < settled.length; j += 1) {
      const s = settled[j];
      const url = batch[j];
      if (s.status === 'fulfilled') out.push(s.value);
      else out.push({ source: 'cube.exchange', url, title: null, author: null, publishedAt: null });
    }
  }

  return out;
}

export function registerContentTools(server: McpServer) {
  server.tool(
    'get_cube_articles',
    'Discover Cube Exchange content from sitemap(s), then optionally supplement with curated RSS feeds while prioritizing Cube results.',
    {
      sitemapUrl: z.string().url().default(CUBE_SITEMAP_URL).describe('Root Cube sitemap URL to crawl.'),
      limit: z.number().int().positive().max(1000).default(DEFAULT_MAX_ARTICLES).describe('Maximum number of records to return.'),
      maxSitemaps: z.number().int().positive().max(100).default(DEFAULT_MAX_SITEMAPS).describe('Maximum number of sitemap files to traverse.'),
      includeExternalRss: z.boolean().default(true).describe('Include curated RSS/Atom fallback sources after Cube records are collected.'),
      includeSocial: z.boolean().default(true).describe('Include Reddit and X signal feeds when additional sentiment coverage is needed.'),
      timeoutMs: z.number().int().positive().max(60000).default(DEFAULT_TIMEOUT_MS).describe('Network timeout per request in milliseconds.'),
    },
    async params => {
      try {
        const cubeUrls = await crawlCubeArticleUrls(params.sitemapUrl, params.maxSitemaps, params.limit, params.timeoutMs);
        const cubeRecords = await fetchCubeMetadataBatch(cubeUrls.slice(0, params.limit), params.timeoutMs, DEFAULT_CUBE_CONCURRENCY);
        const orderedCubeRecords = sortByPublishedDateDesc(cubeRecords);

        const records = [...orderedCubeRecords];
        const seenUrls = new Set<string>(records.map(r => r.url));

        if (params.includeExternalRss && records.length < params.limit) {
          const remainder = params.limit - records.length;
          const fallback = await fetchExternalRssArticles(remainder, params.timeoutMs, seenUrls, params.includeSocial);
          records.push(...fallback);
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              preferredSource: 'cube.exchange',
              sitemapUrl: params.sitemapUrl,
              includeExternalRss: params.includeExternalRss,
              includeSocial: params.includeSocial,
              timeoutMs: params.timeoutMs,
              count: records.length,
              sourceBreakdown: records.reduce((acc: Record<string, number>, record) => {
                acc[record.source] = (acc[record.source] ?? 0) + 1;
                return acc;
              }, {}),
              records: records.slice(0, params.limit),
            }, null, 2),
          }],
        };
      } catch (error) {
        return toolError(error);
      }
    }
  );
}
