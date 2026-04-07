import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { executeFetchDocumentText } from "../src/tools/fetchDocumentText.js";

const configAllowPrivateNet: AppConfig = {
  mcpPort: 8789,
  mcpBind: "127.0.0.1",
  searxngBase: "http://searxng:8080",
  mcpAuthToken: undefined,
  blockPrivateNet: true,
  allowPrivateNet: true,
  maxHtmlBytes: 2_000_000,
  maxPageCount: 50,
  maxDepth: 3,
  maxCharsPerPage: 20_000,
  maxToolTimeoutMs: 30_000,
  maxRedirects: 5,
  robotsMaxBytes: 100_000,
  defaultUserAgent: "pkws-test/1.0"
};

const configBlockPrivateNet: AppConfig = {
  ...configAllowPrivateNet,
  allowPrivateNet: false
};

function escapePdfString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/\r/g, "").replace(/\n/g, "\\n");
}

async function buildSimplePdfDocument(): Promise<Buffer> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <html>
        <head>
          <title>Sample PDF</title>
          <style>
            @page { size: A4; margin: 1in; }
            .break { page-break-after: always; }
            body { font-family: Arial, sans-serif; font-size: 18px; }
          </style>
        </head>
        <body>
          <div class="break">
            <h1>First page</h1>
            <p>This is the first PDF page.</p>
          </div>
          <div>
            <h1>Second page</h1>
            <p>This is the second PDF page.</p>
          </div>
        </body>
      </html>
    `);
    const buffer = await page.pdf({ format: "A4", printBackground: true });
    await page.close();
    return Buffer.from(buffer);
  } finally {
    await browser.close();
  }
}

const pdfBufferPromise = buildSimplePdfDocument();

describe("executeFetchDocumentText", () => {
  let baseUrl = "";
  let server: ReturnType<typeof createServer> | undefined;
  let pdfBuffer: Buffer;

  beforeAll(async () => {
    pdfBuffer = await pdfBufferPromise;

    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

      if (url.pathname === "/plain") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(`Plain document line 1\n${"Long plain text ".repeat(200)}`);
        return;
      }

      if (url.pathname === "/reports/sample.pdf") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(pdfBuffer);
        return;
      }

      if (url.pathname === "/download") {
        res.writeHead(200, {
          "content-type": "application/octet-stream"
        });
        res.end(pdfBuffer);
        return;
      }

      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 120_000);

  afterAll(async () => {
    if (!server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  });

  it("extracts PDF text and page count from a .pdf URL", async () => {
    const result = await executeFetchDocumentText(
      {
        url: `${baseUrl}/reports/sample.pdf`,
        max_chars: 8_000,
        timeout_ms: 10_000
      },
      configAllowPrivateNet
    );

    expect(result.final_url).toBe(`${baseUrl}/reports/sample.pdf`);
    expect(result.status).toBe(200);
    expect(result.content_type).toBe("application/pdf");
    expect(result.title).toBe("Sample PDF");
    expect(result.page_count).toBe(2);
    expect(result.text).toContain("First page");
    expect(result.text).toContain("Second page");
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
  });

  it("detects PDFs from response bytes even without a pdf content type", async () => {
    const result = await executeFetchDocumentText(
      {
        url: `${baseUrl}/download`,
        max_chars: 8_000,
        timeout_ms: 10_000
      },
      configAllowPrivateNet
    );

    expect(result.final_url).toBe(`${baseUrl}/download`);
    expect(result.status).toBe(200);
    expect(result.content_type).toBe("application/pdf");
    expect(result.page_count).toBe(2);
    expect(result.text).toContain("First page");
  });

  it("also extracts plain text documents", async () => {
    const result = await executeFetchDocumentText(
      {
        url: `${baseUrl}/plain`,
        max_chars: 120,
        timeout_ms: 10_000
      },
      configAllowPrivateNet
    );

    expect(result.final_url).toBe(`${baseUrl}/plain`);
    expect(result.status).toBe(200);
    expect(result.content_type).toBe("text/plain");
    expect(result.text).toContain("Plain document line 1");
    expect(result.text.length).toBeLessThanOrEqual(120);
    expect(result.page_count).toBeUndefined();
    expect(result.truncated).toBe(true);
  });

  it("blocks private network targets when private net is disabled", async () => {
    await expect(
      executeFetchDocumentText(
        {
          url: "http://127.0.0.1:65535/blocked",
          max_chars: 1_000,
          timeout_ms: 5_000
        },
        configBlockPrivateNet
      )
    ).rejects.toThrow(/blocked|private|localhost/i);
  });
});
