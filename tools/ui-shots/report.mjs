// WP-TOOLS UI iterate loop: turn a pass's accumulated findings into report.json + report.md.
// See docs/UI-LOOP.md. Importable (buildReport) from shots.mjs, and runnable standalone:
//   node report.mjs --in <dir>/findings.json --out <dir> [--title "pass-00"]

import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = { in: null, out: null, title: "UI loop report" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in") args.in = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--title") args.title = argv[++i];
  }
  return args;
}

/**
 * @param {Array<{screen:string,viewport:string,kind:string,severity:string,detail:string}>} findings
 * @param {{title?:string, screens?:string[], viewports?:string[], pngExt?:string}} meta
 */
export function buildReport(findings, meta = {}) {
  const title = meta.title || "UI loop report";
  const pngExt = meta.pngExt || "png";

  const screens = meta.screens || [...new Set(findings.map((f) => f.screen))].sort();
  const viewports = meta.viewports || [...new Set(findings.map((f) => f.viewport))];

  const byCell = new Map(); // `${screen}::${viewport}` -> findings[]
  for (const f of findings) {
    const key = `${f.screen}::${f.viewport}`;
    if (!byCell.has(key)) byCell.set(key, []);
    byCell.get(key).push(f);
  }

  const byKind = {};
  for (const f of findings) byKind[f.kind] = (byKind[f.kind] || 0) + 1;

  const json = {
    title,
    generatedAt: new Date().toISOString(),
    screens,
    viewports,
    summary: { total: findings.length, byKind },
    findings,
  };

  const lines = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`Generated ${json.generatedAt}. ${findings.length} finding(s) total.`);
  lines.push("");
  if (Object.keys(byKind).length) {
    lines.push("| Kind | Count |");
    lines.push("|---|---|");
    for (const [kind, count] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${kind} | ${count} |`);
    }
    lines.push("");
  }

  lines.push("## Screen x viewport");
  lines.push("");
  lines.push(`| Screen | ${viewports.join(" | ")} |`);
  lines.push(`|---|${viewports.map(() => "---").join("|")}|`);
  for (const screen of screens) {
    const cells = viewports.map((vp) => {
      const key = `${screen}::${vp}`;
      const cellFindings = byCell.get(key) || [];
      const link = `[png](./${screen}-${vp}.${pngExt})`;
      if (cellFindings.length === 0) return `ok ${link}`;
      return `${cellFindings.length} finding(s) ${link}`;
    });
    lines.push(`| ${screen} | ${cells.join(" | ")} |`);
  }
  lines.push("");

  lines.push("## Findings by screen");
  lines.push("");
  for (const screen of screens) {
    const screenFindings = findings.filter((f) => f.screen === screen);
    if (screenFindings.length === 0) continue;
    lines.push(`### ${screen}`);
    lines.push("");
    for (const f of screenFindings) {
      lines.push(`- **${f.kind}** [${f.viewport}] (${f.severity}) -- ${f.detail}`);
    }
    lines.push("");
  }

  return { json, md: lines.join("\n") };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.in || !args.out) {
    console.error("usage: node report.mjs --in <findings.json> --out <dir> [--title \"...\"]");
    process.exit(2);
  }
  const findings = JSON.parse(fs.readFileSync(args.in, "utf8"));
  const { json, md } = buildReport(Array.isArray(findings) ? findings : findings.findings || [], { title: args.title });
  fs.mkdirSync(args.out, { recursive: true });
  fs.writeFileSync(path.join(args.out, "report.json"), JSON.stringify(json, null, 2));
  fs.writeFileSync(path.join(args.out, "report.md"), md);
  console.log(`wrote ${path.join(args.out, "report.json")} and report.md (${json.summary.total} finding(s))`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
