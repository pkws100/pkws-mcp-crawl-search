import { describe, expect, it } from "vitest";
import { ensurePublicHttpUrl, isPrivateIp, SSRFError } from "../src/util/ssrfGuard.js";

const baseConfig = {
  blockPrivateNet: true,
  allowPrivateNet: false
} as const;

describe("ssrfGuard", () => {
  it("detects blocked ipv4 and ipv6 ranges", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("10.0.0.5")).toBe(true);
    expect(isPrivateIp("169.254.1.20")).toBe(true);
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("fc00::1")).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
  });

  it("blocks direct localhost and private ip targets", async () => {
    await expect(ensurePublicHttpUrl("http://localhost/test", baseConfig)).rejects.toBeInstanceOf(SSRFError);
    await expect(ensurePublicHttpUrl("http://127.0.0.1/test", baseConfig)).rejects.toBeInstanceOf(SSRFError);
    await expect(ensurePublicHttpUrl("http://192.168.1.5/test", baseConfig)).rejects.toBeInstanceOf(SSRFError);
  });

  it("blocks hostnames that resolve to private networks", async () => {
    const lookupFn = async () => [{ address: "10.10.10.10", family: 4 }];

    await expect(
      ensurePublicHttpUrl("http://example.test/path", baseConfig, lookupFn as never)
    ).rejects.toBeInstanceOf(SSRFError);
  });

  it("allows private targets only when explicitly overridden", async () => {
    const result = await ensurePublicHttpUrl(
      "http://127.0.0.1:8080/test",
      {
        blockPrivateNet: true,
        allowPrivateNet: true
      },
      async () => [{ address: "127.0.0.1", family: 4 }] as never
    );

    expect(result.toString()).toBe("http://127.0.0.1:8080/test");
  });
});
