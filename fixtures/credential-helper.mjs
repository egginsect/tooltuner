#!/usr/bin/env node
// Test-only external credential helper. Tests supply a fresh private temporary HOME.
// Production operators should configure an OS keychain or encrypted credential helper.
import { constants } from "node:fs";
import { mkdir, lstat, open, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

try {
  let input = "";
  for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 64 * 1024) throw new Error(); }
  const request = JSON.parse(input);
  if (!/^helper:[a-zA-Z0-9._/-]+$/.test(request.reference)) throw new Error();
  const home = process.env.HOME;
  if (!home || !path.isAbsolute(home)) throw new Error();
  const root = await lstat(home);
  if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) !== 0) throw new Error();
  const directory = path.join(home, "credentials");
  await mkdir(directory, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error();
  const target = path.join(directory, createHash("sha256").update(request.reference).digest("hex"));
  if (request.operation === "get") {
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if (((await file.stat()).mode & 0o077) !== 0) throw new Error(); process.stdout.write(await file.readFile("utf8")); }
    finally { await file.close(); }
  } else if (request.operation === "put") {
    const temporary = `${target}.${randomUUID()}`;
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(JSON.stringify(request.value), "utf8"); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, target);
    process.stdout.write('{"stored":true}');
  } else throw new Error();
} catch { process.stderr.write("Test credential helper rejected the request.\n"); process.exitCode = 1; }
