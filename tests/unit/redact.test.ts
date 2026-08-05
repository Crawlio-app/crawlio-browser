import { afterEach, describe, expect, it } from "vitest";
import { isRedactionEnabled, redactSecrets, redactToolText, REDACTED_PAGE_SOURCED_TOOLS } from "../../src/mcp-server/redact.js";
import { applyToolResponseSafety } from "../../src/mcp-server/tool-response-safety.js";

describe("redactSecrets", () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it("redacts sensitive keys recursively", () => {
    const result = redactSecrets({
      user: "rashid",
      authToken: "secret-value",
      nested: { api_key: "abc123456789" },
    }) as Record<string, unknown>;
    expect(result.user).toBe("rashid");
    expect(result.authToken).toBe("[REDACTED]");
    expect((result.nested as Record<string, unknown>).api_key).toBe("[REDACTED]");
  });

  it("redacts JWTs, bearer values, cookies, and sensitive assigned secrets in text", () => {
    const text = [
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
      "session_id=abcdef1234567890abcdef1234567890;",
      "jwt=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghi1234567890",
      "api_key=deadbeefdeadbeefdeadbeefdeadbeef",
    ].join(" ");
    const redacted = redactToolText(text);
    expect(redacted).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(redacted).not.toContain("abcdef1234567890abcdef1234567890");
    expect(redacted).toContain("[REDACTED]");
  });

  it("keeps raw output in explicit RE mode unless forced on", () => {
    process.env.CRAWLIO_CONTEXT_MODE = "traffic-analysis";
    expect(isRedactionEnabled()).toBe(false);
    process.env.CRAWLIO_REDACT_SECRETS = "1";
    expect(isRedactionEnabled()).toBe(true);
  });

  it("redacts JSON tool text", () => {
    const output = redactToolText(JSON.stringify({ cookies: [{ name: "session", value: "abc123456789xyz" }] }));
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("abc123456789xyz");
  });

  it("includes execute so code-mode bridge results are sanitized", () => {
    expect(REDACTED_PAGE_SOURCED_TOOLS.has("execute")).toBe(true);
  });

  it("includes text and traffic page-sourced tools while excluding binary payload tools", () => {
    for (const toolName of [
      "capture_page",
      "stop_network_capture",
      "replay_request",
      "get_websocket_messages",
      "get_response_body",
      "query_object_store",
      "execute",
    ]) {
      expect(REDACTED_PAGE_SOURCED_TOOLS.has(toolName)).toBe(true);
    }
    expect(REDACTED_PAGE_SOURCED_TOOLS.has("print_to_pdf")).toBe(false);
  });

  it("redacts client_secret pure-alpha values without corrupting SHAs, UUIDs, or data URIs", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const alphaSecret = "AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMn";
    const dataUri = "data:image/png;base64,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const redacted = redactToolText([
      `commit=${sha}`,
      `trace=${uuid}`,
      `client_secret=${alphaSecret}`,
      `img=${dataUri}`,
    ].join(" "));

    expect(redacted).toContain(sha);
    expect(redacted).toContain(uuid);
    expect(redacted).toContain(dataUri);
    expect(redacted).not.toContain(alphaSecret);
    expect(redacted).toContain("client_secret=[REDACTED]");
  });

  it("redacts thrown page-sourced tool errors at the response seam", async () => {
    const response = await applyToolResponseSafety({
      toolName: "browser_evaluate",
      response: {
        isError: true,
        content: [{
          type: "text",
          text: "[abcd1234] Error: token=supersecret123456",
        }],
      },
    });

    expect(response.content[0]?.text).toContain("[REDACTED]");
    expect(response.content[0]?.text).not.toContain("supersecret123456");
  });

  it("does not truncate or transform binary PDF text payloads", async () => {
    process.env.CRAWLIO_MAX_OUTPUT = "20";
    const pdfPayload = JSON.stringify({ data: "A".repeat(200), mimeType: "application/pdf" });
    const response = await applyToolResponseSafety({
      toolName: "print_to_pdf",
      response: {
        isError: false,
        content: [{ type: "text", text: pdfPayload }],
      },
    });

    expect(response.content[0]?.text).toBe(pdfPayload);
    expect(response.content[0]?.text).not.toContain("truncated");
  });
});

describe("redactSecrets — provider tokens, encoded values, and non-secret preservation", () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it("redacts vendor secret tokens stored as bare values under benign keys", () => {
    const out = JSON.stringify(redactSecrets({
      config: { value: "sk_test_51HCwKjABCdef0123456789ghIJ" },
      data: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      aws: "AKIAIOSFODNN7EXAMPLE",
      google: "AIzaSyA1234567890abcdefghijklmnopqrstuvw",
    }));
    expect(out).not.toContain("sk_test_51HCwKj");
    expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("AIzaSyA1234567890");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts modern hyphenated OpenAI/Anthropic keys (sk-proj-/sk-svcacct-/sk-ant-)", () => {
    const out = JSON.stringify(redactSecrets({
      // Stored under benign keys the way an SPA persists them in localStorage —
      // this is exactly the shape that leaked before the fix.
      openaiProject: "sk-proj-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKK",
      openaiService: "sk-svcacct-abcdEFGH1234ijklMNOP5678qrstUVWX",
      anthropic: "sk-ant-api03-abcdef_ABCDEF-1234567890ghijklMNOPqrst",
    }));
    expect(out).not.toContain("sk-proj-AAAABBBB");
    expect(out).not.toContain("sk-svcacct-abcdEFGH");
    expect(out).not.toContain("sk-ant-api03-abcdef");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts URL-encoded sensitive assignments", () => {
    const out = redactToolText("https://x.test/cb?data=api_key%3Dsupersecretvalue123");
    expect(out).not.toContain("supersecretvalue123");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts secrets nested inside double-encoded JSON string values", () => {
    const out = redactToolText(JSON.stringify({ payload: JSON.stringify({ api_key: "AKIAIOSFODNN7EXAMPLE" }) }));
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).toContain("[REDACTED]");
  });

  it("preserves non-secret hashes, UUIDs, and versions as object values", () => {
    const result = redactSecrets({
      commit: "0123456789abcdef0123456789abcdef01234567",
      contentHash: "9f86d081884c7d659a2feaa0c55ad015",
      trace: "550e8400-e29b-41d4-a716-446655440000",
      version: "1.2.34",
    }) as Record<string, unknown>;
    expect(result.commit).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(result.contentHash).toBe("9f86d081884c7d659a2feaa0c55ad015");
    expect(result.trace).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(result.version).toBe("1.2.34");
  });
});
