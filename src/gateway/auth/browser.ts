/** Browser-flow cookies contain no owner claims; durable pending state authenticates them. */
import type { Request, Response } from "express";
export const flowCookie = (id: string): string => `__Host-tt-flow-${id}`;
export const verifierCookie = (id: string): string => `__Host-tt-pkce-${id}`;
export const sessionCookie = (id: string): string => `__Host-tt-session-${id}`;
export function readCookie(req: Request, name: string): string {
  const matches = (req.headers.cookie ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  // Duplicate cookies are ambiguous and fail closed.
  return matches.length === 1 ? matches[0]!.slice(name.length + 1) : "";
}
export function writeCookie(res: Response, name: string, value: string, seconds = 600): void {
  res.cookie(name, value, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: seconds * 1000 });
}
export function clearFlow(res: Response, id: string): void {
  for (const name of [flowCookie(id), verifierCookie(id), sessionCookie(id)]) writeCookie(res, name, "", 0);
}
