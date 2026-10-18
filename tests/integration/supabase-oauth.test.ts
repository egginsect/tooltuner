/** Synthetic identities only; exercises real FalkorDB transactions, never a live Auth provider. */
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { GraphClient } from "../../src/db/client.js";
import { bootstrapSchema, INDEX_SPECS } from "../../src/db/schema.js";
import * as store from "../../src/db/auth.js";
import { FlywheelOAuthProvider } from "../../src/gateway/oauth/provider.js";
import { flowCookie } from "../../src/gateway/auth/browser.js";
import { newId, type Grant } from "../../src/contracts.js";
const A="11111111-1111-4111-8111-111111111111", B="22222222-2222-4222-8222-222222222222";
const resource="https://gateway.example/mcp", callback="https://client.example/callback";
const client={client_id:"synthetic-client",redirect_uris:[callback],token_endpoint_auth_method:"none" as const};
const grants=[A,B].map((owner):Grant=>({schema_version:1,grant_id:newId("grant"),owner_id:owner,label:"Synthetic tenant grant",groups:["user"],allow:{apps:["sample"],tools:{},repos:[]},scope:{},created_at:new Date().toISOString(),revoked_at:null}));
let db:GraphClient;
const provider=()=>new FlywheelOAuthProvider({db,ownerId:"legacy",ownerSecret:undefined,resource,multiuser:true});
beforeAll(async()=>{
  const url=process.env.FALKORDB_URL;if(!url)throw new Error("Set an explicit disposable FALKORDB_URL");
  db=await GraphClient.connect({url,graph:`supabase_oauth_${randomUUID().replaceAll("-","")}`});
  await bootstrapSchema(db,INDEX_SPECS);for(const g of grants)await store.insertGrant(db,g);
});
afterAll(async()=>{if(db){try{await db.dropGraph();}finally{await db.close();}}});
async function pending(p:FlywheelOAuthProvider){
  let html="";const cookies:Record<string,string>={};
  const res={status:()=>res,set:()=>res,cookie:(n:string,v:string)=>{cookies[n]=v;return res;},send:(v:string)=>{html=v;return res;}};
  await p.authorize(client,{redirectUri:callback,codeChallenge:"a".repeat(43),state:"synthetic-state"},res as unknown as Response);
  const id=/name="request_id" value="([^"]+)"/.exec(html)![1]!;return{id,browser:cookies[flowCookie(id)]!};
}
async function select(p:FlywheelOAuthProvider,flow:{id:string;browser:string},owner:string){
  const result=await p.authenticateUser({requestId:flow.id,browserToken:flow.browser,userId:owner});
  if(!("html" in result))throw new Error("Synthetic login failed");
  return /name="selection_token" value="([^"]+)"/.exec(result.html)![1]!;
}
describe("durable multiuser OAuth",()=>{
  it("binds one-use browser callback across instances before tenant consent",async()=>{
    const p=provider(),flow=await pending(p),verifier="v".repeat(43);
    expect(await p.browserOAuth(flow.id,flow.browser,verifier,false)).toBe(true);
    expect(await provider().browserOAuth(flow.id,"x".repeat(43),verifier,true)).toBe(false);
    const claimed=await Promise.all([provider(),provider()].map(x=>x.browserOAuth(flow.id,flow.browser,verifier,true)));
    expect(claimed.filter(Boolean)).toHaveLength(1);
    const token=await select(provider(),flow,A);expect(token).toHaveLength(43);
  });
  it("persists tenant and subject through code, tokens and refresh, and revokes replayed families",async()=>{
    const p=provider(),flow=await pending(p),selection=await select(p,flow,A);
    const outcome=await provider().completeConsent({requestId:flow.id,browserToken:flow.browser,userId:A,selectionToken:selection,grantId:grants[0]!.grant_id,approve:true});
    if(!("redirectTo" in outcome))throw new Error("Synthetic approval failed");
    const code=new URL(outcome.redirectTo).searchParams.get("code")!;
    expect(await store.peekCode(db,code)).toMatchObject({owner_id:A,subject:`supabase:${A}`});
    const tokens=await provider().exchangeAuthorizationCode(client,code,undefined,callback,new URL(resource));
    expect(await store.getToken(db,tokens.access_token)).toMatchObject({owner_id:A,subject:`supabase:${A}`,revoked:false});
    expect((await provider().verifyAccessToken(tokens.access_token)).extra).toMatchObject({principal:{owner_id:A,subject:`supabase:${A}`}});
    const refreshed=await provider().exchangeRefreshToken(client,tokens.refresh_token!);
    expect(await store.getToken(db,refreshed.access_token)).toMatchObject({owner_id:A,subject:`supabase:${A}`,revoked:false});
    await expect(provider().exchangeRefreshToken(client,tokens.refresh_token!)).rejects.toThrow("already used");
    await expect(provider().verifyAccessToken(refreshed.access_token)).rejects.toThrow();
  });
  it("rejects switched accounts and foreign grants without issuing a code",async()=>{
    const p=provider(),flow=await pending(p),selection=await select(p,flow,A);
    const input={requestId:flow.id,browserToken:flow.browser,userId:A,selectionToken:selection,grantId:grants[1]!.grant_id,approve:true};
    expect(await provider().completeConsent({...input,userId:B})).toMatchObject({status:403});
    expect(await provider().completeConsent(input)).toMatchObject({status:400});
  });
  it("atomically prevents another tenant from reusing a family or refreshing its token",async()=>{
    const now=Math.floor(Date.now()/1000),family=randomUUID();
    const a={owner_id:A,subject:`supabase:${A}`,client_id:client.client_id,grant_id:grants[0]!.grant_id,family_id:family,resource,scopes:["flywheel"]};
    expect(await store.issueTokenPair(db,"synthetic-access-a","synthetic-refresh-a",a,A,now,now+300,now+600)).toBe(true);
    const b={...a,owner_id:B,subject:`supabase:${B}`,grant_id:grants[1]!.grant_id};
    expect(await store.issueTokenPair(db,"synthetic-access-b","synthetic-refresh-b",b,B,now,now+300,now+600)).toBe(false);
    expect(await store.issueTokenPair(db,"synthetic-access-b","synthetic-refresh-b",b,B,now,now+300,now+600,"synthetic-refresh-a")).toBe(false);
    expect(await store.getToken(db,"synthetic-access-b")).toBeNull();
    expect(await store.getToken(db,"synthetic-refresh-a")).toMatchObject({owner_id:A,revoked:false});
  });
});
