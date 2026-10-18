/** Minimal Supabase Auth client. Passwords/tokens are never logged, persisted or returned in errors. */
import { z } from "zod";
export const UserId = z.string().uuid();
export interface SupabaseAuthConfig { url: string; publishableKey: string }
export interface HumanSession { userId: string; accessToken: string; expiresIn: number }
export interface HumanAuth {
  password(email: string, password: string): Promise<HumanSession>;
  exchange(code: string, verifier: string): Promise<HumanSession>;
  user(accessToken: string): Promise<string>;
  authorizeUrl(callback: string, challenge: string): string;
}
export function createSupabaseAuth(config: SupabaseAuthConfig, fetcher: typeof fetch = fetch): HumanAuth {
  const origin = new URL(config.url);
  if (origin.protocol !== "https:" || origin.origin !== config.url) throw new Error("Supabase Auth requires an exact HTTPS origin");
  async function request(path: string, body?: Record<string, string>, token?: string): Promise<unknown> {
    try {
      const response = await fetcher(`${config.url}/auth/v1/${path}`, {
        method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { apikey: config.publishableKey, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(); }
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      let size = 0; const chunks: Uint8Array[] = [];
      for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length;
        if (size > 64 * 1024) { await reader.cancel(); throw new Error(); } chunks.push(part.value); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch { throw new Error("Sign-in could not be verified. Restart the connection and try again."); }
  }
  async function user(accessToken: string): Promise<string> {
    if (!accessToken || accessToken.length > 8192 || /[\r\n]/.test(accessToken)) throw new Error("Sign-in is required");
    const parsed = z.object({ id: UserId, is_anonymous: z.literal(false), aud: z.literal("authenticated"), email_confirmed_at: z.string().min(1) }).safeParse(await request("user", undefined, accessToken));
    if (!parsed.success) throw new Error("A verified, non-anonymous account is required");
    return parsed.data.id;
  }
  async function session(path: string, body: Record<string, string>): Promise<HumanSession> {
    const started = Date.now();
    const parsed = z.object({ access_token: z.string().min(1).max(8192), expires_in: z.number().positive().finite(), token_type: z.literal("bearer") }).safeParse(await request(path, body));
    if (!parsed.success) throw new Error("Sign-in returned an invalid session");
    const userId = await user(parsed.data.access_token);
    const expiresIn = Math.min(600, Math.floor(parsed.data.expires_in - (Date.now() - started) / 1000 - 1));
    if (expiresIn <= 0) throw new Error("Sign-in session expired");
    return { accessToken: parsed.data.access_token, userId, expiresIn };
  }
  return {
    user,
    password: (email, password) => session("token?grant_type=password", { email, password }),
    exchange: (code, verifier) => session("token?grant_type=pkce", { auth_code: code, code_verifier: verifier }),
    authorizeUrl(callback, challenge) {
      const url = new URL(`${config.url}/auth/v1/authorize`);
      url.search = new URLSearchParams({ provider: "google", redirect_to: callback, code_challenge: challenge, code_challenge_method: "s256" }).toString();
      return url.href;
    },
  };
}
