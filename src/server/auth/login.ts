/**
 * Login Page — HTML rendering for the OAuth provider-selection UI.
 *
 * Rendered by the OAuth provider core when multiple upstream providers are configured
 * and the user navigates to `GET /authorize` without a `?provider=` parameter.
 * Named "login" to accommodate future login methods beyond OAuth provider selection
 * (e.g. SSO, magic link, passkey).
 *
 * @module server/auth/login
 */

/**
 * Minimal provider descriptor needed to render the login page.
 * Satisfied by {@link ResolvedProvider} (has `name` and `displayName`).
 */
export interface SelectableProvider {
  readonly name: string;
  readonly displayName: string;
}

/**
 * Renders the provider-selection HTML page.
 * Each provider button links back to the original authorize URL with a `?provider=` parameter.
 */
export function renderSelectionPage(originalUrl: string, providers: readonly SelectableProvider[]): string {
  const providerButtons = providers
    .map((prov) => {
      const separator = originalUrl.includes("?") ? "&" : "?";
      const href = `${originalUrl}${separator}provider=${encodeURIComponent(prov.name)}`;
      return `
        <a href="${escapeHtml(href)}" class="provider-btn">
          <span class="provider-icon">${providerIconSvg(prov.name)}</span>
          <span>Continue with ${escapeHtml(prov.displayName)}</span>
        </a>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign in</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f5f5;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      color: #111;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 2px 16px rgba(0,0,0,0.10);
      padding: 40px 36px;
      width: 100%;
      max-width: 360px;
    }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 8px; }
    p { font-size: 0.875rem; color: #666; margin-bottom: 28px; }
    .provider-btn {
      display: flex;
      align-items: center;
      gap: 12px;
      width: 100%;
      padding: 11px 16px;
      margin-bottom: 12px;
      border: 1px solid #ddd;
      border-radius: 8px;
      background: #fff;
      font-size: 0.9375rem;
      font-weight: 500;
      color: #111;
      text-decoration: none;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
    }
    .provider-btn:hover { background: #f9f9f9; border-color: #bbb; }
    .provider-btn:last-child { margin-bottom: 0; }
    .provider-icon { display: flex; align-items: center; flex-shrink: 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Sign in</h1>
    <p>Choose how you'd like to continue</p>
    ${providerButtons}
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function providerIconSvg(name: string): string {
  const type = name.startsWith("oidc:") ? "oidc" : name;
  switch (type) {
    case "google":
      return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
      </svg>`;
    case "github":
      return `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/>
      </svg>`;
    default:
      return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/>
      </svg>`;
  }
}
