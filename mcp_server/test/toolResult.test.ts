import { describe, expect, it } from "vitest";
import { isStructuredContentCandidate, toToolResult } from "../src/mcp/toolResult.js";

describe("toToolResult", () => {
  it("omits structuredContent for array payloads", () => {
    const result = toToolResult([
      {
        title: "Example",
        url: "https://example.com",
        snippet: "Snippet"
      }
    ]);

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            [
              {
                title: "Example",
                url: "https://example.com",
                snippet: "Snippet"
              }
            ],
            null,
            2
          )
        }
      ]
    });
    expect("structuredContent" in result).toBe(false);
    expect(isStructuredContentCandidate([])).toBe(false);
  });

  it("keeps structuredContent for object payloads", () => {
    const payload = {
      final_url: "https://example.com",
      status: 200
    };

    const result = toToolResult(payload);

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify(payload, null, 2)
        }
      ],
      structuredContent: payload
    });
    expect(isStructuredContentCandidate(payload)).toBe(true);
  });
});
