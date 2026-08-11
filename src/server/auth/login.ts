/**
 * Login Page — HTML rendering for the unified OAuth login UI.
 *
 * This is the framework's **generic** default login page renderer.
 * Applications with product-specific branding should provide a custom
 * {@link LoginPageRenderer} via {@link CreateOAuthProviderOptions.renderLoginPage}.
 *
 * @module server/auth/login
 */

import { escapeHtml } from "../../utils/string-helpers.js";

// ============================================================================
// Public Types
// ============================================================================

/** Minimal provider descriptor needed to render the selection page. */
export interface SelectableProvider {
  readonly name: string;
  readonly displayName: string;
}

/**
 * Local (username/password) form context passed to the login page renderer.
 * Carries OAuth client parameters so the form POST to `/authorize/local` can
 * mint an authorization code for the same client flow.
 */
export interface LocalLoginForm {
  /** Label for the form section. */
  readonly displayName: string;
  /** Client redirect URI from the authorize request. */
  readonly redirectUri: string;
  /** Client state from the authorize request. */
  readonly state: string;
  /** PKCE code challenge from the authorize request. */
  readonly codeChallenge: string;
}

/**
 * Interface for custom login page renderers.
 *
 * Implement this and pass it as `renderLoginPage` to `createOAuthProvider` to replace
 * the framework's generic login page with a branded, application-specific one.
 *
 * @example
 * ```typescript
 * const myLoginPage: LoginPageRenderer = {
 *   renderSelectionPage(originalUrl, providers, localForm, error) {
 *     return `<!DOCTYPE html>...`;
 *   },
 *   renderSuccessRedirectPage(redirectUrl) {
 *     return `<!DOCTYPE html>...`;
 *   },
 * };
 *
 * await createOAuthProvider(providers, { serverUrl, renderLoginPage: myLoginPage });
 * ```
 */
export interface LoginPageRenderer {
  /**
   * Render the provider/credential selection page shown at `GET /authorize`.
   *
   * @param originalUrl - Full `/authorize` request URL (for provider links + form replay)
   * @param providers - OAuth providers to offer (may be empty when only local login is enabled)
   * @param localForm - Local form context, when local login is configured
   * @param error - Optional error message (wrong credentials, OAuth error, etc.)
   */
  renderSelectionPage(
    originalUrl: string,
    providers: readonly SelectableProvider[],
    localForm?: LocalLoginForm,
    error?: string,
  ): string;

  /**
   * Render the confirmation page shown after a successful local login.
   * Should auto-redirect to `redirectUrl` (meta-refresh recommended; no inline JS needed).
   *
   * @param redirectUrl - MCP client's redirect_uri with code + state params
   */
  renderSuccessRedirectPage(redirectUrl: string): string;
}

// ============================================================================
// Default implementation (generic, no product branding, no external assets)
// ============================================================================

/**
 * Renders a brief "Signed in" confirmation page that auto-redirects to
 * `redirectUrl` after one second via `<meta http-equiv="refresh">`.
 */
export function renderSuccessRedirectPage(redirectUrl: string): string {
  const safeUrl = escapeHtml(redirectUrl);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="1; url=${safeUrl}">
  <title>Signed in</title>
  <style>
    ${BASE_CSS}
    .card { text-align: center; }
    .check {
      width: 52px; height: 52px; border-radius: 50%;
      background: var(--accent-subtle); color: var(--accent);
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 1.25rem;
    }
    .back { font-size: 0.8125rem; color: var(--accent); text-decoration: none; }
    .back:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <div class="check">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    </div>
    <h1>Signed in</h1>
    <p>Returning you to the application&hellip;</p>
    <a href="${safeUrl}" class="back">Continue if not redirected automatically</a>
  </div>
</body>
</html>`;
}

/**
 * Renders the unified login page with OAuth provider buttons and/or a local login form.
 */
export function renderSelectionPage(
  originalUrl: string,
  providers: readonly SelectableProvider[],
  localForm?: LocalLoginForm,
  error?: string,
): string {
  const hasLocal = localForm !== undefined;
  const hasProviders = providers.length > 0;

  const providerButtons = providers
    .map((prov) => {
      const separator = originalUrl.includes("?") ? "&" : "?";
      const href = `${originalUrl}${separator}provider=${encodeURIComponent(prov.name)}`;
      return `<a href="${escapeHtml(href)}" class="provider-btn">
        <span class="provider-icon">${providerIconSvg(prov.name)}</span>
        <span>Continue with ${escapeHtml(prov.displayName)}</span>
      </a>`;
    })
    .join("\n");

  const errorBanner = error
    ? `<div class="error" role="alert">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        ${escapeHtml(error)}
      </div>`
    : "";

  const divider = hasLocal && hasProviders ? `<div class="divider"><span>or</span></div>` : "";

  const localFormHtml = localForm
    ? `<form method="POST" action="/authorize/local" novalidate>
        <input type="hidden" name="redirect_uri"  value="${escapeHtml(localForm.redirectUri)}">
        <input type="hidden" name="state"          value="${escapeHtml(localForm.state)}">
        <input type="hidden" name="code_challenge" value="${escapeHtml(localForm.codeChallenge)}">
        <input type="hidden" name="authorize_url"  value="${escapeHtml(originalUrl)}">
        <div class="field">
          <label class="sr-only" for="username">Username</label>
          <input id="username" type="text" name="username" class="input" placeholder="Username"
                 autocomplete="username" autocapitalize="off" spellcheck="false" required>
        </div>
        <div class="field">
          <label class="sr-only" for="password">Password</label>
          <input id="password" type="password" name="password" class="input" placeholder="Password"
                 autocomplete="current-password" required>
        </div>
        <button type="submit" class="submit-btn">Sign in</button>
      </form>`
    : "";

  const subtitle =
    hasProviders && !hasLocal
      ? "Choose a provider to continue"
      : hasProviders && hasLocal
        ? "Sign in with your account or a provider"
        : "Sign in with your credentials";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign in</title>
  <style>
    ${BASE_CSS}
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.25rem; color: var(--text); }
    .subtitle { font-size: 0.875rem; color: var(--muted); margin-bottom: 1.5rem; }
    .provider-btn {
      display: flex; align-items: center; gap: 12px; width: 100%;
      padding: 10px 16px; margin-bottom: 10px;
      border: 1px solid var(--border); border-radius: 8px;
      background: var(--card); font-size: 0.9375rem; font-weight: 500;
      color: var(--text); text-decoration: none;
      transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
    }
    .provider-btn:hover {
      background: var(--hover); border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-ring);
    }
    .provider-btn:last-of-type { margin-bottom: 0; }
    .provider-icon { display: flex; align-items: center; flex-shrink: 0; color: var(--text); }
    .divider {
      display: flex; align-items: center; color: var(--muted);
      font-size: 0.8125rem; margin: 1.25rem 0;
    }
    .divider::before, .divider::after { content: ""; flex: 1; border-bottom: 1px solid var(--border); }
    .divider span { padding: 0 12px; }
    .field { margin-bottom: 0.75rem; }
    .input {
      width: 100%; padding: 10px 14px; border: 1.5px solid var(--border);
      border-radius: 7px; font-size: 0.9375rem; font-family: inherit;
      background: var(--input-bg); color: var(--text);
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .input::placeholder { color: var(--muted); opacity: 0.8; }
    .input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ring); }
    .submit-btn {
      width: 100%; padding: 10px 16px; border: none; border-radius: 7px;
      background: var(--accent); color: #fff; font-size: 0.9375rem; font-weight: 600;
      cursor: pointer; margin-top: 0.25rem;
      transition: background 0.15s;
    }
    .submit-btn:hover { background: var(--accent-hover); }
    .error {
      display: flex; align-items: flex-start; gap: 0.5rem;
      background: var(--error-bg); border: 1px solid var(--error-border); color: var(--error-text);
      border-radius: 7px; padding: 0.625rem 0.875rem; font-size: 0.875rem;
      margin-bottom: 1rem; line-height: 1.4;
    }
    .error svg { flex-shrink: 0; margin-top: 1px; }
    .sr-only {
      position: absolute; width: 1px; height: 1px; padding: 0;
      margin: -1px; overflow: hidden; clip: rect(0,0,0,0); border: 0;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Sign in</h1>
    <p class="subtitle">${escapeHtml(subtitle)}</p>
    ${errorBanner}
    ${providerButtons}
    ${divider}
    ${localFormHtml}
  </div>
</body>
</html>`;
}

/**
 * The framework's default {@link LoginPageRenderer} — generic, no product branding,
 * no external assets. Used by `createOAuthProvider` when no custom renderer is provided.
 */
export const defaultLoginPage: LoginPageRenderer = { renderSelectionPage, renderSuccessRedirectPage };

// ============================================================================
// Internal: CSS — neutral light/dark theme (no CDN, no external assets)
// ============================================================================

const BASE_CSS = `
  :root {
    --bg:           #f7f8fa;
    --card:         #ffffff;
    --border:       #d0d5de;
    --text:         #111827;
    --muted:        #6b7280;
    --hover:        #f3f4f6;
    --input-bg:     #ffffff;
    --accent:       #2563eb;
    --accent-hover: #1d4ed8;
    --accent-subtle:#eff6ff;
    --accent-ring:  rgba(37,99,235,0.18);
    --error-bg:     #fef2f2;
    --error-border: #fecaca;
    --error-text:   #991b1b;
    --shadow:       0 4px 20px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.06);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:           #0f1117;
      --card:         #1a1d27;
      --border:       #2d3148;
      --text:         #e8eaf0;
      --muted:        #8890a8;
      --hover:        #21253a;
      --input-bg:     #141620;
      --accent:       #60a5fa;
      --accent-hover: #93c5fd;
      --accent-subtle:rgba(96,165,250,0.14);
      --accent-ring:  rgba(96,165,250,0.22);
      --error-bg:     #2c1010;
      --error-border: #5a2020;
      --error-text:   #f4a0a0;
      --shadow:       0 4px 20px rgba(0,0,0,0.50), 0 1px 3px rgba(0,0,0,0.30);
    }
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    background: var(--bg);
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; color: var(--text);
    -webkit-font-smoothing: antialiased;
  }
  .card {
    background: var(--card); border-radius: 12px; box-shadow: var(--shadow);
    border: 1px solid var(--border); padding: 36px 32px;
    width: 100%; max-width: 368px;
  }
`;

// ============================================================================
// Internal: Provider icons
// ============================================================================

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
      return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"
           xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <circle cx="12" cy="12" r="10"/>
        <path d="M12 8v4l2.5 2.5"/>
      </svg>`;
  }
}
