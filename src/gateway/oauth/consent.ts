/** Owner consent page (TOO-77). The owner picks which grant this client session gets. */
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Grant } from "../../contracts.js";

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function describeGrant(g: Grant): string {
  const tools = Object.entries(g.allow.tools)
    .map(([app, list]) => `${app}:[${list.join(",")}]`)
    .join(" ");
  const scope = [g.scope.job_id && `job ${g.scope.job_id}`, g.scope.packet_id && `packet ${g.scope.packet_id}`]
    .filter(Boolean)
    .join(", ");
  return [
    `groups: ${g.groups.join(" + ")}`,
    `apps: ${g.allow.apps.join(", ")}`,
    tools && `tools: ${tools}`,
    g.allow.repos.length > 0 && `repos: ${g.allow.repos.join(", ")}`,
    scope && `scope: ${scope}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function renderOwnerLoginPage(input: {
  requestId: string;
  client: OAuthClientInformationFull;
  resource: string;
  ownerSecretConfigured: boolean;
}): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Owner login · MCP Flywheel</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font:15px system-ui;max-width:640px;margin:2rem auto;padding:0 1rem">
<h1>Sign in to authorize MCP client</h1>
<p><b>${esc(input.client.client_name ?? input.client.client_id)}</b> wants to access <code>${esc(input.resource)}</code>.</p>
<p>Enter the owner secret to review available grants and the selected callback. Login does not approve access.</p>
${input.ownerSecretConfigured ? "" : '<p>FLYWHEEL_OWNER_SECRET is not configured. Ask the operator to configure it before connecting.</p>'}
<form method="post" action="/oauth/owner-login">
<input type="hidden" name="request_id" value="${esc(input.requestId)}">
<p><label>Owner secret <input type="password" name="owner_secret" autocomplete="current-password" required></label></p>
<button type="submit" ${input.ownerSecretConfigured ? "" : "disabled"}>Continue</button>
<button type="submit" name="decision" value="deny" formaction="/oauth/consent" formnovalidate>Deny</button>
</form></body></html>`;
}

export function renderConsentPage(input: {
  requestId: string;
  selectionToken: string;
  client: OAuthClientInformationFull;
  resource: string;
  redirectUri: string;
  grants: Grant[];
}): string {
  const clientName = input.client.client_name ?? input.client.client_id;
  const options = input.grants
    .map(
      (g, i) => `<label class="grant"><input type="radio" name="grant_id" value="${esc(g.grant_id)}" ${i === 0 ? "checked" : ""}>
        <b>${esc(g.label)}</b> <code>${esc(g.grant_id)}</code><br><small>${esc(describeGrant(g))}</small></label>`,
    )
    .join("\n");
  const blocked = input.grants.length === 0
    ? `<p class="warn">No active grants. Create one with <code>npm run owner -- grant create ...</code> and restart the connection.</p>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Authorize ${esc(clientName)} · MCP Flywheel</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:15px system-ui;max-width:640px;margin:2rem auto;padding:0 1rem}.grant{display:block;border:1px solid #ccc;border-radius:6px;padding:.6rem;margin:.4rem 0}
.warn{color:#a40}code{font-size:12px}button{padding:.5rem 1rem;margin-right:.5rem}</style></head><body>
<h1>Authorize MCP client</h1>
<p><b>${esc(clientName)}</b> wants to access <code>${esc(input.resource)}</code>.</p>
<p>Redirect: <code>${esc(input.redirectUri)}</code></p>
<p>Choose the grant this client session receives. The grant, not the client brand, decides which tools it can use.
Human merge and stable activation are never part of any grant. This selection expires in five minutes.</p>
${blocked}
<form method="post" action="/oauth/consent">
<input type="hidden" name="request_id" value="${esc(input.requestId)}">
<input type="hidden" name="selection_token" value="${esc(input.selectionToken)}">
${options}
<button type="submit" name="decision" value="approve" ${input.grants.length === 0 ? "disabled" : ""}>Approve</button>
<button type="submit" name="decision" value="deny" formnovalidate>Deny</button>
</form></body></html>`;
}

export function renderConsentError(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Authorization error</title></head><body style="font:15px system-ui;max-width:640px;margin:2rem auto">
<h1>Authorization error</h1><p>${esc(message)}</p><p>Go back and try again.</p></body></html>`;
}
