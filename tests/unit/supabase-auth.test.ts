import type { Express, Request, Response as ExpressResponse, RequestHandler } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newId, type Grant } from "../../src/contracts.js";
import type { GraphClient } from "../../src/db/client.js";
import * as store from "../../src/db/auth.js";
import { FlywheelOAuthProvider } from "../../src/gateway/oauth/provider.js";
import { createSupabaseAuth } from "../../src/gateway/auth/supabase.js";
import { mountHumanAuth } from "../../src/gateway/auth/routes.js";
import { flowCookie, verifierCookie, sessionCookie, readCookie, writeCookie, clearFlow } from "../../src/gateway/auth/browser.js";
import { createRuntime } from "../../src/runtime.js";
import * as schema from "../../src/db/schema.js";
import * as postgres from "../../src/gateway/postgres-credentials.js";
import { loadConfig } from "../../src/config.js";
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const db = {} as GraphClient, origin = "https://gateway.example", resource = `${origin}/mcp`;
const client = { client_id: "client", redirect_uris: ["https://client.example/callback"], token_endpoint_auth_method: "none" as const };
const grant = (owner: string): Grant => ({ schema_version: 1, grant_id: newId("grant"), owner_id: owner, label: `Grant ${owner}`, groups: ["user"], allow: { apps: ["sample"], tools: {}, repos: [] }, scope: {}, created_at: new Date().toISOString(), revoked_at: null });
const ga = grant(A), gb = grant(B);
const opts = { db, ownerId: "legacy-owner", ownerSecret: undefined, resource, multiuser: true };
function response() {
  const cookies: Record<string, string> = {}; let html = "";
  const res = { status: vi.fn(() => res), set: vi.fn(() => res), type: vi.fn(() => res), redirect: vi.fn(() => res),
    cookie: vi.fn((name: string, value: string) => { cookies[name] = value; return res; }),
    send: vi.fn((value: string) => { html = value; return res; }) };
  return { res: res as unknown as ExpressResponse, cookies, html: () => html, mocks: res };
}
async function pending(p: FlywheelOAuthProvider) {
  const r = response();
  await p.authorize(client, { redirectUri: client.redirect_uris[0]!, codeChallenge: "a".repeat(43), scopes: ["flywheel"] }, r.res);
  const id = /name="request_id" value="([^"]+)"/.exec(r.html())![1]!;
  return { id, browser: r.cookies[flowCookie(id)]!, html: r.html() };
}
beforeEach(() => {
  const rows = new Map<string, { doc: string; state: string; expires: number; selection?: string; callback?: string; callbackUsed?: boolean }>();
  const key = (binding: store.PendingBinding, id: string) => `${binding.ownerId}|${binding.resource}|${id}`;
  vi.spyOn(store, "insertPendingAuthorization").mockImplementation(async (_d, b, id, doc, expires) => { rows.set(key(b,id), { doc, expires, state: "login" }); return true; });
  vi.spyOn(store, "readPendingAuthorization").mockImplementation(async (_d,b,id,now) => { const r = rows.get(key(b,id)); return r && r.expires > now && ["login","selection"].includes(r.state) ? r.doc : null; });
  vi.spyOn(store, "claimPendingLogin").mockImplementation(async (_d,b,id,now) => { const r = rows.get(key(b,id)); if (!r || r.expires <= now || r.state !== "login") return null; r.state = "claimed"; return r.doc; });
  vi.spyOn(store, "finishPendingLogin").mockImplementation(async (_d,b,id,now,doc,selection) => { const r = rows.get(key(b,id)); if (!r || r.expires <= now || r.state !== "claimed") return false; Object.assign(r,{doc,selection,state:"selection"}); return true; });
  vi.spyOn(store, "consumePendingAuthorization").mockImplementation(async (_d,b,id,now,approve,selection) => { const r = rows.get(key(b,id)); if (!r || r.expires <= now || !["login","selection"].includes(r.state) || (approve && r.selection !== selection)) return null; r.state="consumed"; return r.doc; });
  vi.spyOn(store, "beginBrowserOAuth").mockImplementation(async (_d,b,id,_now,hash) => { const r=rows.get(key(b,id)); if (!r || r.callback) return false; r.callback=hash; return true; });
  vi.spyOn(store, "claimBrowserOAuth").mockImplementation(async (_d,b,id,_now,hash) => { const r=rows.get(key(b,id)); if (!r || r.callback!==hash || r.callbackUsed) return false; r.callbackUsed=true; return true; });
  vi.spyOn(store,"listGrants").mockImplementation(async (_d,owner) => [ga,gb].filter(g=>g.owner_id===owner));
});
afterEach(() => vi.restoreAllMocks());
describe("Supabase tenant identity", () => {
  it("authenticates two independent users without exposing foreign grants or permitting owner-secret fallback", async () => {
    const p=new FlywheelOAuthProvider(opts), pa=await pending(p), pb=await pending(p);
    expect(store.listGrants).not.toHaveBeenCalled();
    expect(await p.authenticateOwner({requestId:pa.id,ownerSecret:"anything"})).toMatchObject({status:403});
    expect(await p.authenticateUser({requestId:pa.id,browserToken:pb.browser,userId:A})).toMatchObject({status:403});
    const a=await p.authenticateUser({requestId:pa.id,browserToken:pa.browser,userId:A});
    const b=await p.authenticateUser({requestId:pb.id,browserToken:pb.browser,userId:B});
    expect(a).toHaveProperty("html");expect(b).toHaveProperty("html");
    expect((a as {html:string}).html).toContain(ga.grant_id);expect((a as {html:string}).html).not.toContain(gb.grant_id);
    expect((b as {html:string}).html).toContain(gb.grant_id);expect((b as {html:string}).html).not.toContain(ga.grant_id);
  });
  it("binds consent to the same user and browser, persists human subject, and consumes once", async () => {
    const p=new FlywheelOAuthProvider(opts), flow=await pending(p);
    const login=await p.authenticateUser({requestId:flow.id,browserToken:flow.browser,userId:A}) as {html:string};
    const selection=/name="selection_token" value="([^"]+)"/.exec(login.html)![1]!;
    const input={requestId:flow.id,browserToken:flow.browser,userId:A,selectionToken:selection,grantId:ga.grant_id,approve:true};
    vi.spyOn(store,"getGrant").mockResolvedValue(ga);const codes=vi.spyOn(store,"insertCode").mockResolvedValue();
    expect(await p.completeConsent({...input,userId:B})).toMatchObject({status:403});
    expect(await p.completeConsent({...input,browserToken:"x".repeat(43)})).toMatchObject({status:403});
    expect(codes).not.toHaveBeenCalled();
    expect(await p.completeConsent(input)).toHaveProperty("redirectTo");
    expect(codes.mock.calls[0]![2]).toMatchObject({owner_id:A,subject:`supabase:${A}`});
    expect(await p.completeConsent(input)).toMatchObject({status:400});
  });
  it("rejects foreign grant selection and grants nothing to an unprovisioned UUID", async () => {
    const p=new FlywheelOAuthProvider(opts), flow=await pending(p);
    const login=await p.authenticateUser({requestId:flow.id,browserToken:flow.browser,userId:A}) as {html:string};
    const token=/name="selection_token" value="([^"]+)"/.exec(login.html)![1]!;
    vi.spyOn(store,"getGrant").mockResolvedValue(gb); const codes=vi.spyOn(store,"insertCode").mockResolvedValue();
    expect(await p.completeConsent({requestId:flow.id,browserToken:flow.browser,userId:A,selectionToken:token,grantId:gb.grant_id,approve:true})).toMatchObject({status:400});expect(codes).not.toHaveBeenCalled();
    const other=await pending(p); const empty=await p.authenticateUser({requestId:other.id,browserToken:other.browser,userId:"33333333-3333-4333-8333-333333333333"});
    expect((empty as {html:string}).html).toContain("No active grants");
  });
  it("consumes OAuth callback attempts once across provider instances and rejects another browser",async()=>{
    const p=new FlywheelOAuthProvider(opts), flow=await pending(p), verifier="v".repeat(43);
    expect(await p.browserOAuth(flow.id,flow.browser,verifier,false)).toBe(true);
    expect(await p.browserOAuth(flow.id,"x".repeat(43),verifier,true)).toBe(false);
    expect(await new FlywheelOAuthProvider(opts).browserOAuth(flow.id,flow.browser,verifier,true)).toBe(true);
    expect(await p.browserOAuth(flow.id,flow.browser,verifier,true)).toBe(false);
  });
  it("rejects legacy, foreign-grant and forged-subject tokens, retaining the verified human in MCP principal",async()=>{
    const p=new FlywheelOAuthProvider(opts);
    const token={kind:"access" as const,client_id:client.client_id,grant_id:ga.grant_id,family_id:"family",resource,scopes:["flywheel"],expires_at:Math.floor(Date.now()/1000)+300,revoked:false};
    const get=vi.spyOn(store,"getToken").mockResolvedValue(token);vi.spyOn(store,"getGrant").mockResolvedValue(ga);
    await expect(p.verifyAccessToken("legacy")).rejects.toThrow("tenant identity");
    get.mockResolvedValue({...token,owner_id:A,subject:`supabase:${B}`});await expect(p.verifyAccessToken("forged")).rejects.toThrow();
    get.mockResolvedValue({...token,owner_id:B,subject:`supabase:${B}`});await expect(p.verifyAccessToken("foreign-grant")).rejects.toThrow();
    get.mockResolvedValue({...token,owner_id:A,subject:`supabase:${A}`});expect((await p.verifyAccessToken("own")).extra).toMatchObject({principal:{owner_id:A,subject:`supabase:${A}`}});
  });
  it("cannot refresh into another user's grant or revoke another client's token",async()=>{
    const p=new FlywheelOAuthProvider(opts);const get=vi.spyOn(store,"getToken").mockResolvedValue({kind:"refresh",owner_id:A,subject:`supabase:${A}`,client_id:client.client_id,grant_id:gb.grant_id,family_id:"family",resource,scopes:["flywheel"],expires_at:Math.floor(Date.now()/1000)+300,revoked:false});
    vi.spyOn(store,"getGrant").mockResolvedValue(gb);const issue=vi.spyOn(store,"issueTokenPair").mockResolvedValue(true),revoke=vi.spyOn(store,"revokeFamily").mockResolvedValue();
    await expect(p.exchangeRefreshToken(client,"refresh")).rejects.toThrow();expect(issue).not.toHaveBeenCalled();
    await p.revokeToken({...client,client_id:"other-client"},{token:"refresh"});expect(revoke).not.toHaveBeenCalled();
    get.mockResolvedValue(null);await p.revokeToken(client,{token:"unknown"});expect(revoke).not.toHaveBeenCalled();
  });
});
describe("Supabase REST validation",()=>{
  const config={url:"https://project.supabase.co",publishableKey:"sb_publishable_synthetic"};
  it("uses a fixed origin, redirect rejection, and live user validation; ignores claimed metadata owners",async()=>{
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({access_token:"synthetic-access",expires_in:3600,token_type:"bearer",refresh_token:"must-not-be-retained"})).mockResolvedValueOnce(Response.json({id:A,is_anonymous:false,aud:"authenticated",email_confirmed_at:"2026-01-01",user_metadata:{owner_id:B}}));
    const session=await createSupabaseAuth(config,fetcher).password("user@example.invalid","synthetic-password");
    expect(session).toEqual({userId:A,accessToken:"synthetic-access",expiresIn:600});
    expect(fetcher.mock.calls.map(c=>c[0])).toEqual([`${config.url}/auth/v1/token?grant_type=password`,`${config.url}/auth/v1/user`]);
    for(const [,init] of fetcher.mock.calls){expect(init?.redirect).toBe("error");expect(init?.signal).toBeDefined();}
  });
  it("rejects anonymous, unconfirmed and malformed identities without leaking provider errors",async()=>{
    for(const user of [{id:A,is_anonymous:true,aud:"authenticated",email_confirmed_at:"yes"},{id:A,is_anonymous:false,aud:"authenticated"},{id:"owner",is_anonymous:false,aud:"authenticated",email_confirmed_at:"yes"}]){
      await expect(createSupabaseAuth(config,vi.fn<typeof fetch>().mockResolvedValue(Response.json(user))).user("token")).rejects.toThrow();
    }
    const auth=createSupabaseAuth(config,vi.fn<typeof fetch>().mockResolvedValue(new Response("secret-provider-message",{status:400})));
    await expect(auth.password("user@example.invalid","synthetic-password")).rejects.toThrow("Sign-in could not be verified");
  });
  it("restricts configuration to a publishable key and disables legacy fallback",()=>{
    expect(()=>loadConfig({TOOLTUNER_AUTH_MODE:"supabase",TOOLTUNER_PUBLIC_ORIGIN:origin,SUPABASE_URL:config.url,SUPABASE_PUBLISHABLE_KEY:"sb_secret_forbidden"})).toThrow();
    expect(()=>loadConfig({TOOLTUNER_AUTH_MODE:"supabase",TOOLTUNER_PUBLIC_ORIGIN:origin,SUPABASE_URL:config.url,SUPABASE_PUBLISHABLE_KEY:config.publishableKey,TOOLTUNER_OWNER_SECRET:"s".repeat(32)})).toThrow();
    expect(loadConfig({TOOLTUNER_OWNER_ID:A}).owner.id).toBe(A);
  });
});
// No listening socket: invoke actual route handlers using synthetic request/response objects.
describe("human login route boundary",()=>{
  it("blocks cross-origin password submissions before calling Supabase",async()=>{
    const handlers=new Map<string,RequestHandler>();
    const app={use:vi.fn(),post:(path:string,...hs:RequestHandler[])=>handlers.set(path,hs.at(-1)!),get:(path:string,...hs:RequestHandler[])=>handlers.set(path,hs.at(-1)!)} as unknown as Express;
    const auth={password:vi.fn(),exchange:vi.fn(),user:vi.fn(),authorizeUrl:vi.fn()};
    const p=new FlywheelOAuthProvider(opts), flow=await pending(p);
    mountHumanAuth(app,{auth,provider:p,origin,limiter:vi.fn()});
    const req={body:{request_id:flow.id,csrf:flow.browser,email:"user@example.invalid",password:"synthetic"},headers:{cookie:`${flowCookie(flow.id)}=${flow.browser}`},get:()=>"https://attacker.example"} as unknown as Request;
    const r=response();await handlers.get("/auth/password")!(req,r.res,vi.fn());expect(r.mocks.status).toHaveBeenCalledWith(403);expect(auth.password).not.toHaveBeenCalled();
    const callback={query:{request_id:flow.id,code:"synthetic-code"},headers:{cookie:`${verifierCookie(flow.id)}=${"v".repeat(43)}`}} as unknown as Request;
    await handlers.get("/auth/callback")!(callback,r.res,vi.fn());expect(auth.exchange).not.toHaveBeenCalled();
  });
});


describe("multiuser runtime composition", () => {
  it("requires the restricted RLS adapter and never enables the legacy owner-secret provider", async () => {
    vi.spyOn(schema,"bootstrapSchema").mockResolvedValue({graph:"synthetic",schemaVersion:1,indexesCreated:0,constraintsCreated:0,freshGraph:false});
    const storeFactory=vi.spyOn(postgres,"createPostgresCredentialStore").mockReturnValue({get:vi.fn(),initialize:vi.fn(),close:vi.fn()});
    const environment={TOOLTUNER_AUTH_MODE:"supabase",TOOLTUNER_PUBLIC_ORIGIN:origin,SUPABASE_URL:"https://project.supabase.co",SUPABASE_PUBLISHABLE_KEY:"sb_publishable_synthetic",TOOLTUNER_CREDENTIAL_ACTIVE_KEY_VERSION:"v1",
      TOOLTUNER_CREDENTIAL_POSTGRES_URL:"postgresql://synthetic@localhost/synthetic",TOOLTUNER_CREDENTIAL_KEYS:JSON.stringify({v1:Buffer.alloc(32).toString("base64")})};
    const runtime=await createRuntime({config:loadConfig(environment),db,environment});
    expect(storeFactory.mock.calls[0]![0]).toMatchObject({requireRls:true});
    expect(runtime.provider?.multiuser).toBe(true);
    expect(await runtime.provider!.authenticateOwner({requestId:"synthetic",ownerSecret:"anything"})).toMatchObject({status:403});
    expect(runtime.readiness.find(i=>i.name==="supabase_auth")?.status).toBe("unverified");
  });
});


describe("browser cookie contract", () => {
  it("pins secure HttpOnly same-site cookies, identical clearing, and rejects duplicate names", () => {
    const r=response();
    for (const name of [flowCookie("id"),verifierCookie("id"),sessionCookie("id")]) {
      writeCookie(r.res,name,"synthetic-value",120);
      expect(r.mocks.cookie).toHaveBeenCalledWith(name,"synthetic-value",{httpOnly:true,secure:true,sameSite:"lax",path:"/",maxAge:120000});
    }
    clearFlow(r.res,"id");
    expect(r.mocks.cookie).toHaveBeenCalledWith(sessionCookie("id"),"",{httpOnly:true,secure:true,sameSite:"lax",path:"/",maxAge:0});
    expect(readCookie({headers:{cookie:"name=one; name=two"}} as Request,"name")).toBe("");
    expect(readCookie({headers:{cookie:"other=value; name=one"}} as Request,"name")).toBe("one");
  });
  it("accepts a same-origin password flow only with its matching nonce and writes an expiring user session",async()=>{
    const handlers=new Map<string,RequestHandler>();
    const app={use:vi.fn(),post:(path:string,...hs:RequestHandler[])=>handlers.set(path,hs.at(-1)!),get:(path:string,...hs:RequestHandler[])=>handlers.set(path,hs.at(-1)!)} as unknown as Express;
    const auth={password:vi.fn().mockResolvedValue({userId:A,accessToken:"synthetic-access",expiresIn:90}),exchange:vi.fn(),user:vi.fn(),authorizeUrl:vi.fn()};
    const p=new FlywheelOAuthProvider(opts),flow=await pending(p);mountHumanAuth(app,{auth,provider:p,origin,limiter:vi.fn()});
    const req={body:{request_id:flow.id,csrf:"x".repeat(43),email:"user@example.invalid",password:"synthetic"},headers:{cookie:`${flowCookie(flow.id)}=${flow.browser}`},get:()=>origin} as unknown as Request;
    const failed=response();await handlers.get("/auth/password")!(req,failed.res,vi.fn());expect(auth.password).not.toHaveBeenCalled();
    req.body.csrf=flow.browser;const success=response();await handlers.get("/auth/password")!(req,success.res,vi.fn());
    expect(auth.password).toHaveBeenCalledOnce();expect(success.html()).toContain(ga.grant_id);expect(success.html()).not.toContain(gb.grant_id);
    expect(success.mocks.cookie).toHaveBeenCalledWith(sessionCookie(flow.id),"synthetic-access",{httpOnly:true,secure:true,sameSite:"lax",path:"/",maxAge:90000});
  });
});
