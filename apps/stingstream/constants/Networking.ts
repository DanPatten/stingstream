/**
 * How this app addresses a StingStream node.
 *
 * Its own file rather than a line in `Values.ts` because networking is one of the domains the
 * constants convention names: the gateway's port is policy shared by the code that *probes* for a
 * node and the code that *explains* it to somebody, and those two have no other reason to know
 * about each other.
 */

/**
 * The StingStream gateway's default port.
 *
 * Every "curl the node" instruction in the repository uses it, `docs/RUNNING.md` and the e2e
 * scripts assume it, and the node's own `config.toml` ships it as `[gateway] port`. Read from
 * `/healthz` when the answer matters and use this as the fallback: a node can be configured onto
 * another port, so this is the shipped default rather than the truth.
 */
export const NODE_GATEWAY_PORT = 8790;
