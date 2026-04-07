import { describe, expect, it } from "vitest";
import { extractMainContent } from "../src/util/contentExtract.js";

describe("extractMainContent", () => {
  it("prefers main/article content over navigation boilerplate", () => {
    const html = `
      <html lang="en">
        <head>
          <title>Example Article</title>
          <meta name="description" content="A clean article" />
          <link rel="canonical" href="https://example.com/articles/1" />
        </head>
        <body>
          <header><nav><a href="/home">Home</a><a href="/pricing">Pricing</a></nav></header>
          <main>
            <article>
              <h1>Example Article</h1>
              <p>This is the main article text with meaningful content.</p>
              <p>It should be preferred over navigation, footer, and cookie banners.</p>
            </article>
          </main>
          <footer>Legal Privacy Cookies Careers</footer>
        </body>
      </html>
    `;

    const result = extractMainContent(html, {
      finalUrl: "https://example.com/articles/1"
    });

    expect(result.title).toBe("Example Article");
    expect(result.mainText).toContain("main article text");
    expect(result.mainText).not.toContain("Legal Privacy");
    expect(result.headings[0]?.text).toBe("Example Article");
    expect(result.metadata.canonical_url).toBe("https://example.com/articles/1");
    expect(result.content_hash).toHaveLength(64);
  });

  it("falls back to body text when no strong main section exists", () => {
    const html = `
      <html>
        <head><title>Fallback</title></head>
        <body>
          Plain fallback body text.
          <span>Additional context.</span>
        </body>
      </html>
    `;

    const result = extractMainContent(html);

    expect(result.title).toBe("Fallback");
    expect(result.mainText).toContain("Plain fallback body text");
    expect(result.mainText).toContain("Additional context");
  });
});
