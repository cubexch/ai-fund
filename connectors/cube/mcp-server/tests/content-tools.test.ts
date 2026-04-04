import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerContentTools } from '../src/tools/content';

function createMockServer() {
  const tools = new Map<string, Function>();
  return {
    tool: vi.fn((name: string, _desc: string, _schema: any, handler: Function) => {
      tools.set(name, handler);
    }),
    getHandler: (name: string) => tools.get(name),
  };
}

describe('registerContentTools', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.stubGlobal('fetch', originalFetch);
  });

  it('registers get_cube_articles tool', () => {
    const server = createMockServer();
    registerContentTools(server as any);

    expect(server.tool).toHaveBeenCalledTimes(1);
    expect(server.getHandler('get_cube_articles')).toBeDefined();
  });

  it('returns Cube content first and then optional RSS fallback records', async () => {
    const server = createMockServer();
    registerContentTools(server as any);

    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://cube.exchange/sitemap.xml') {
        return new Response(`
          <sitemapindex>
            <sitemap><loc>https://www.cube.exchange/content-sitemap.xml</loc></sitemap>
          </sitemapindex>
        `, { status: 200 });
      }

      if (url === 'https://www.cube.exchange/content-sitemap.xml') {
        return new Response(`
          <urlset>
            <url><loc>https://www.cube.exchange/what-is/solana</loc></url>
            <url><loc>https://cube.exchange/pricing</loc></url>
          </urlset>
        `, { status: 200 });
      }

      if (url === 'https://www.cube.exchange/what-is/solana') {
        return new Response(`
          <html><head>
            <meta property="og:title" content="What Is Solana?" />
            <meta name="author" content="Cube Editorial" />
            <meta property="article:published_time" content="2026-04-03T10:00:00Z" />
          </head></html>
        `, { status: 200 });
      }

      if (url === 'https://www.coindesk.com/arc/outboundfeeds/rss/') {
        return new Response(`
          <rss><channel>
            <item>
              <title>CoinDesk Headline</title>
              <link>https://www.coindesk.com/test-story</link>
              <author>news@coindesk.com</author>
              <pubDate>Sat, 04 Apr 2026 00:00:00 GMT</pubDate>
            </item>
          </channel></rss>
        `, { status: 200 });
      }

      return new Response('', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock as any);

    const handler = server.getHandler('get_cube_articles')!;
    const result = await handler({
      sitemapUrl: 'https://cube.exchange/sitemap.xml',
      limit: 2,
      maxSitemaps: 5,
      includeExternalRss: true,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);

    expect(data.preferredSource).toBe('cube.exchange');
    expect(data.count).toBe(2);

    expect(data.records[0]).toMatchObject({
      source: 'cube.exchange',
      url: 'https://www.cube.exchange/what-is/solana',
      title: 'What Is Solana?',
      author: 'Cube Editorial',
      publishedAt: '2026-04-03T10:00:00Z',
    });

    expect(data.records[1]).toMatchObject({
      source: 'CoinDesk',
      url: 'https://www.coindesk.com/test-story',
      title: 'CoinDesk Headline',
    });
  });


  it('can pull sentiment fallbacks from Reddit and X feeds when news feeds are unavailable', async () => {
    const server = createMockServer();
    registerContentTools(server as any);

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://cube.exchange/sitemap.xml') {
        return new Response('<urlset></urlset>', { status: 200 });
      }
      if (url === 'https://www.reddit.com/r/CryptoCurrency/new/.rss') {
        return new Response(`
          <rss><channel>
            <item>
              <title>Reddit Sentiment Thread</title>
              <link>https://www.reddit.com/r/CryptoCurrency/comments/abc123/sample/</link>
              <pubDate>Sat, 04 Apr 2026 01:00:00 GMT</pubDate>
            </item>
          </channel></rss>
        `, { status: 200 });
      }
      if (url === 'https://nitter.net/cubeexchange/rss') {
        return new Response(`
          <rss><channel>
            <item>
              <title>Cube X update</title>
              <link>https://x.com/cubeexchange/status/123</link>
              <pubDate>Sat, 04 Apr 2026 01:10:00 GMT</pubDate>
            </item>
          </channel></rss>
        `, { status: 200 });
      }
      return new Response('', { status: 503 });
    }) as any);

    const handler = server.getHandler('get_cube_articles')!;
    const result = await handler({
      sitemapUrl: 'https://cube.exchange/sitemap.xml',
      limit: 2,
      maxSitemaps: 2,
      includeExternalRss: true,
      includeSocial: true,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.count).toBe(2);
    const sources = data.records.map((r: any) => r.source);
    expect(sources).toContain('Reddit r/CryptoCurrency');
    expect(sources).toContain('X @cubeexchange');
  });

  it('supports disabling external RSS fallback', async () => {
    const server = createMockServer();
    registerContentTools(server as any);

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://cube.exchange/sitemap.xml') {
        return new Response('<urlset></urlset>', { status: 200 });
      }
      return new Response('', { status: 404 });
    }) as any);

    const handler = server.getHandler('get_cube_articles')!;
    const result = await handler({
      sitemapUrl: 'https://cube.exchange/sitemap.xml',
      limit: 5,
      maxSitemaps: 2,
      includeExternalRss: false,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.records).toEqual([]);
  });

  it('returns error when root sitemap request fails', async () => {
    const server = createMockServer();
    registerContentTools(server as any);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })) as any);

    const handler = server.getHandler('get_cube_articles')!;
    const result = await handler({
      sitemapUrl: 'https://cube.exchange/sitemap.xml',
      limit: 5,
      maxSitemaps: 2,
      includeExternalRss: false,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Request failed (500)');
  });
});
