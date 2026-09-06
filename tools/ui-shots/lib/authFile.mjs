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
