import { describe, expect, it } from "vitest";
import {
  sanitizeNetworkEntry,
  sanitizeValue,
} from "@/extension/resident-sanitizer";

const SECRET = "resident-secret-regression";
const SECRET_URL = `https://example.test/training?token=${SECRET}`;

describe("resident artifact sanitizer", () => {
  it.each(["Referer", "referer", "REFERRER", "referrer"])(
    "redacts sensitive query values in a mixed-case %s header",
    (headerName) => {
      const entry = sanitizeNetworkEntry({
        url: "https://example.test/api",
        method: "GET",
        status: 200,
        mimeType: "application/json",
        size: 2,
        transferSize: 2,
        durationMs: 1,
        resourceType: "Fetch",
        requestId: "request-1",
        requestHeaders: { [headerName]: SECRET_URL },
      });

      expect(entry.requestHeaders?.[headerName]).toContain("token=%5BREDACTED%5D");
      expect(JSON.stringify(entry)).not.toContain(SECRET);
    },
  );

  it("redacts URL-shaped values and credential headers at the same persistence boundary", () => {
    const sanitized = sanitizeValue({
      currentPageUrl: `${SECRET_URL}#session=${SECRET}`,
      requestHeaders: {
        Authorization: `Bearer ${SECRET}`,
        Referer: SECRET_URL,
      },
    });
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain("[REDACTED]");
  });
});
