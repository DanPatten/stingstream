// Read the generated admin credentials out of a node's runtime.json, silently -- never logged,
// never echoed, never passed back out except as the two in-memory strings the caller needs to
// type into a form. See docs/UI-LOOP.md and the ground rule this whole package was built under:
// the generated admin password never appears in output, logs or commits.

import fs from "node:fs";

/**
 * @param {string} passFilePath path to a node's runtime.json
 * @returns {{username: string, password: string}}
 */
export function readAdminCredentials(passFilePath) {
  if (!passFilePath) {
    throw new Error("--pass-file is required to sign in (a path to the node's runtime.json)");
  }
  let runtime;
  try {
    runtime = JSON.parse(fs.readFileSync(passFilePath, "utf8"));
  } catch (err) {
    throw new Error(`could not read --pass-file ${passFilePath}: ${err.message}`);
  }
  const admin = runtime.jellyfin_admin;
  if (!admin || !admin.username || !admin.password) {
    throw new Error(`${passFilePath} has no jellyfin_admin.username/password -- is the node still wiring up?`);
  }
  return { username: admin.username, password: admin.password };
}

/**
 * F-36 (pass-02 critique): once a node's first-run setup completes, WP-CORE scrubs the generated
 * admin password out of runtime.json (by design -- it should not live forever), so
 * readAdminCredentials() above stops working for a node that has already been set up. This is the
 * credentials file shots.mjs reads with --creds for that case: a plain {username, password} JSON,
 * chosen by whoever ran --first-run (or by hand), living wherever the caller points it -- never
 * inside the repo, and not runtime.json.
 *
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
