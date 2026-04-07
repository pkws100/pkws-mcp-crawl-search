import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { executeFindLeads } from "../src/tools/findLeads.js";

const config: AppConfig = {
  mcpPort: 8789,
  mcpBind: "127.0.0.1",
  searxngBase: "http://searxng:8080",
  mcpAuthToken: undefined,
  blockPrivateNet: true,
  allowPrivateNet: false,
  maxHtmlBytes: 2_000_000,
  maxPageCount: 50,
  maxDepth: 3,
  maxCharsPerPage: 20_000,
  maxToolTimeoutMs: 30_000,
  maxRedirects: 5,
  robotsMaxBytes: 100_000,
  defaultUserAgent: "pkws-test/1.0"
};

describe("executeFindLeads", () => {
  it("interprets a local business query and returns enriched business leads", async () => {
    const fetchMock = async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/search?")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                title: "Salon Alpha - Sonneberg | Offizielle Webseite",
                url: "https://salon-alpha.de/",
                content: "Friseur in 96515 Sonneberg"
              },
              {
                title: "Salon Alpha in Sonneberg - Gelbe Seiten",
                url: "https://www.gelbeseiten.de/salon-alpha-sonneberg",
                content: "Adresse und Telefonnummer von Salon Alpha"
              },
              {
                title: "Salon Beta | Friseur in Sonneberg",
                url: "https://salon-beta.de/",
                content: "Ihr Friseur in Sonneberg"
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      if (url === "https://salon-alpha.de/") {
        return new Response(
          `<!doctype html><html><head><title>Salon Alpha | Friseur in Sonneberg</title></head><body>
            <main><h1>Salon Alpha</h1><a href="/impressum">Impressum</a></main>
          </body></html>`,
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }

      if (url === "https://salon-alpha.de/impressum") {
        return new Response(
          `<!doctype html><html><head><title>Impressum - Salon Alpha</title></head><body>
            <main><p>Salon Alpha GmbH</p><p>Musterstraße 1, 96515 Sonneberg</p><p><a href="mailto:kontakt@salon-alpha.de">kontakt@salon-alpha.de</a></p></main>
          </body></html>`,
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }

      if (url === "https://salon-beta.de/") {
        return new Response(
          `<!doctype html><html><head><title>Salon Beta | Friseur in Sonneberg</title></head><body>
            <main><h1>Salon Beta</h1><a href="/kontakt">Kontakt</a></main>
          </body></html>`,
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }

      if (url === "https://salon-beta.de/kontakt") {
        return new Response(
          `<!doctype html><html><head><title>Kontakt - Salon Beta</title></head><body>
            <main><p>Telefon: +49 3675 987654</p><p>E-Mail: team@salon-beta.de</p></main>
          </body></html>`,
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }

      if (url === "https://www.gelbeseiten.de/salon-alpha-sonneberg") {
        return new Response(
          `<!doctype html><html><head><title>Salon Alpha in Sonneberg - Gelbe Seiten</title></head><body><main>Directory listing</main></body></html>`,
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await executeFindLeads(
      {
        query: "20 Friseure im Bereich 96515 Sonneberg",
        limit: 2,
        country: "DE",
        language: "de",
        source_strategy: "hybrid_public",
        include_contact_pages: true,
        include_evidence: true
      },
      config,
      {
        fetchImpl: fetchMock as typeof fetch,
        searchFetchImpl: fetchMock as typeof fetch,
        lookupFn: async () => [{ address: "93.184.216.34", family: 4 }] as never
      }
    );

    expect(result.interpreted_query.postal_code).toBe("96515");
    expect(result.interpreted_query.location).toBe("Sonneberg");
    expect(result.leads.length).toBe(2);
    expect(result.leads.some((lead) => lead.website === "https://salon-alpha.de/")).toBe(true);
    expect(result.leads.some((lead) => lead.contacts.emails.includes("kontakt@salon-alpha.de"))).toBe(true);
    expect(result.stats.websites_resolved).toBeGreaterThanOrEqual(2);
  });
});
