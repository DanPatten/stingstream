// The F-36 credentials file: a plain {username, password} JSON, chosen by whoever ran --first-run
// (or by hand), living wherever the caller points it -- never inside the repo, and never
// runtime.json. Read/written silently -- never logged, never echoed, never passed back out except
// as the two in-memory strings the caller needs to type into a form. See docs/UI-LOOP.md and the
// ground rule this whole package was built under: a generated password never appears in output,
// logs or commits.
//
// F-36 follow-up (WP2, 2026-09-06): this file used to also export readAdminCredentials(), which
// read a node's runtime.json directly -- WP-CORE's setup renames the bootstrap admin and scrubs
// the generated password out of runtime.json once setup completes, so that read only ever worked
// before first-run finished, and broke every later step in this package that ran after it
// (tools/ui-startup.ps1's restart+login pass, specifically). Removed outright rather than kept as
// a trap: --creds/--first-run (this file's readCreds/writeCreds) is the only credentials path
// every script in this package uses now.

import fs from "node:fs";

/**
 * @param {string} credsFilePath
 * @returns {{username: string, password: string}}
 */
export function readCreds(credsFilePath) {
  if (!credsFilePath) {
    throw new Error("--creds is required (a path to a {username,password} JSON file)");
  }
  let creds;
  try {
    creds = JSON.parse(fs.readFileSync(credsFilePath, "utf8"));
  } catch (err) {
    throw new Error(`could not read --creds ${credsFilePath}: ${err.message}`);
  }
  if (!creds.username || !creds.password) {
    throw new Error(`${credsFilePath} has no username/password`);
  }
  return { username: creds.username, password: creds.password };
}

/**
 * Written by --first-run once it creates the account through the firstrun-* form, so a later run
 * against the same (now set-up) node can sign back in with --creds instead of trying to create
 * the account again. Never logged; the caller passes the in-memory values straight through.
 *
 * @param {string} credsFilePath
 * @param {{username: string, password: string}} creds
 */
export function writeCreds(credsFilePath, creds) {
  if (!credsFilePath) return;
  fs.writeFileSync(credsFilePath, JSON.stringify({ username: creds.username, password: creds.password }, null, 2));
}
