import { describe, it, expect } from "vitest";

import { parseClientRedirectUri } from "./http.js";

describe("parseClientRedirectUri", () => {
  it("accepts HTTPS on any host", () => {
    expect(parseClientRedirectUri("https://app.example.com/callback")?.href).toBe("https://app.example.com/callback");
  });

  it("accepts HTTP only on loopback interfaces (RFC 8252 §8.3)", () => {
    expect(parseClientRedirectUri("http://localhost:1234/cb")?.hostname).toBe("localhost");
    expect(parseClientRedirectUri("http://127.0.0.1:8080/cb")?.hostname).toBe("127.0.0.1");
  });

  it("rejects HTTP on non-loopback hosts", () => {
    expect(parseClientRedirectUri("http://example.com/cb")).toBeNull();
    expect(parseClientRedirectUri("http://192.168.1.10:9999/cb")).toBeNull();
  });

  it("accepts private-use URI schemes used by native clients (RFC 8252 §7.1)", () => {
    // Short custom schemes as emitted by real MCP clients.
    expect(parseClientRedirectUri("claude://claude.ai/mcp-auth-callback/sdk")?.protocol).toBe("claude:");
    expect(parseClientRedirectUri("vscode://ms-vscode.callback")?.protocol).toBe("vscode:");
    expect(parseClientRedirectUri("cursor://anysphere.cursor-retrieval/callback")?.protocol).toBe("cursor:");
    // Reverse-domain private-use scheme as recommended by RFC 8252 §7.1.
    expect(parseClientRedirectUri("com.example.app:/oauth2redirect")?.protocol).toBe("com.example.app:");
  });

  it("rejects schemes that can execute script or read local resources", () => {
    expect(parseClientRedirectUri("javascript:alert(1)")).toBeNull();
    expect(parseClientRedirectUri("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(parseClientRedirectUri("vbscript:msgbox(1)")).toBeNull();
    expect(parseClientRedirectUri("file:///etc/passwd")).toBeNull();
    expect(parseClientRedirectUri("blob:https://example.com/uuid")).toBeNull();
  });

  it("rejects strings that are not valid URIs", () => {
    expect(parseClientRedirectUri("not a uri")).toBeNull();
    expect(parseClientRedirectUri("")).toBeNull();
  });
});
