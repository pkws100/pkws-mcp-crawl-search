import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { executeExtractBusinessContacts } from "../src/tools/extractBusinessContacts.js";

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

describe("executeExtractBusinessContacts", () => {
  it("extracts public business contacts from impressum and contact pages", async () => {
    const fetchMock = async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "https://salon-alpha.de/") {
        return new Response(
          `<!doctype html><html><head><title>Salon Alpha</title></head><body>
            <main><h1>Salon Alpha</h1><a href="/impressum">Impressum</a><a href="/kontakt">Kontakt</a></main>
          </body></html>`,
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }

      if (url === "https://salon-alpha.de/impressum") {
        return new Response(
          `<!doctype html><html><head><title>Impressum - Salon Alpha</title></head><body>
            <main>
              <h1>Impressum</h1>
              <p>Salon Alpha GmbH</p>
              <p>Musterstraße 1, 96515 Sonneberg</p>
              <p><a href="mailto:kontakt@salon-alpha.de">kontakt@salon-alpha.de</a></p>
              <p><a href="tel:+49 3675 123456">+49 3675 123456</a></p>
              <p>Geschäftsführerin: Anna Becker</p>
              <script type="application/ld+json">
                {"@type":"LocalBusiness","name":"Salon Alpha GmbH","telephone":"+49 3675 123456","address":{"@type":"PostalAddress","streetAddress":"Musterstraße 1","postalCode":"96515","addressLocality":"Sonneberg"}}
              </script>
            </main>
          </body></html>`,
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }

      if (url === "https://salon-alpha.de/kontakt") {
        return new Response(
          `<!doctype html><html><head><title>Kontakt</title></head><body>
            <main><h1>Kontakt</h1><p>Termin unter info@salon-alpha.de</p></main>
          </body></html>`,
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await executeExtractBusinessContacts(
      {
        url: "https://salon-alpha.de/",
        max_pages: 4,
        rendered: false
      },
      config,
      {
        fetchImpl: fetchMock as typeof fetch,
        lookupFn: async () => [{ address: "93.184.216.34", family: 4 }] as never
      }
    );

    expect(result.impressum_found).toBe(true);
    expect(result.contact_pages.some((page) => page.page_type === "impressum")).toBe(true);
    expect(result.contacts.emails).toContain("kontakt@salon-alpha.de");
    expect(result.contacts.phones).toContain("+493675123456");
    expect(result.contacts.addresses.some((address) => address.includes("96515 Sonneberg"))).toBe(true);
    expect(result.contacts.contact_people).toContain("Anna Becker");
    expect(result.confidence).toBeGreaterThanOrEqual(80);
  });

  it("ignores hidden script-only contacts and keeps public freemail addresses when they are visible", async () => {
    const fetchMock = async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "https://freemail-salon.de/") {
        return new Response(
          `<!doctype html><html><head><title>Salon Freemail</title></head><body>
            <main><h1>Salon Freemail</h1><a href="/kontakt">Kontakt</a></main>
          </body></html>`,
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }

      if (url === "https://freemail-salon.de/kontakt") {
        return new Response(
          `<!doctype html><html><head><title>Kontakt - Salon Freemail</title></head><body>
            <main>
              <p>Salon Freemail</p>
              <p>E-Mail: salon.freemail@gmail.com</p>
              <div hidden>hidden@freemail-salon.de</div>
              <div style="display:none">secret@freemail-salon.de</div>
              <div hidden>Inhaber: Versteckte Person</div>
              <div style="display:none">Geheimstraße 9, 96515 Sonneberg</div>
              <script>window.hiddenEmail = "intern@freemail-salon.de";</script>
            </main>
          </body></html>`,
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await executeExtractBusinessContacts(
      {
        url: "https://freemail-salon.de/",
        max_pages: 3,
        rendered: false
      },
      config,
      {
        fetchImpl: fetchMock as typeof fetch,
        lookupFn: async () => [{ address: "93.184.216.34", family: 4 }] as never
      }
    );

    expect(result.contacts.emails).toContain("salon.freemail@gmail.com");
    expect(result.contacts.emails).not.toContain("intern@freemail-salon.de");
    expect(result.contacts.emails).not.toContain("hidden@freemail-salon.de");
    expect(result.contacts.emails).not.toContain("secret@freemail-salon.de");
    expect(result.contacts.contact_people).not.toContain("Versteckte Person");
    expect(result.contacts.addresses.some((address) => address.includes("Geheimstraße 9"))).toBe(false);
  });
});
