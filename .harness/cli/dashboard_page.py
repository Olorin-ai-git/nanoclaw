"""Dashboard page frame and styles — self-contained, system fonts only."""

CSS = """
:root {
  --paper: #FAFBFC; --ink: #16202B; --grid: #E3E8ED; --muted: #64748B;
  --ok: #2F7D4F; --warn: #B7791F; --canon: #1D5FBF; --broken: #A03232;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  background: var(--paper); color: var(--ink);
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
  background-image: linear-gradient(var(--grid) 1px, transparent 1px),
    linear-gradient(90deg, var(--grid) 1px, transparent 1px);
  background-size: 32px 32px; background-position: -1px -1px;
}
.wrap { max-width: 1080px; margin: 0 auto; padding: 32px 24px 64px; }
h1, h2 {
  font-family: "Avenir Next Condensed", "Arial Narrow", "Helvetica Neue", sans-serif;
  text-transform: uppercase; letter-spacing: 0.14em; font-weight: 600;
}
h1 { font-size: 30px; }
h2 { font-size: 16px; color: var(--muted); margin: 40px 0 12px;
  border-bottom: 2px solid var(--ink); padding-bottom: 4px; }
.mono, td, .ledger-row, .statebar { font-family: "SF Mono", Menlo, Consolas, monospace; }
.masthead { display: flex; justify-content: space-between; align-items: baseline;
  flex-wrap: wrap; gap: 8px; border-bottom: 3px double var(--ink); padding-bottom: 12px; }
.masthead .meta { font-size: 12px; color: var(--muted); text-align: right; }
.statebar { margin: 16px 0 0; padding: 10px 14px; background: #fff;
  border: 1px solid var(--grid); border-left: 4px solid var(--canon); font-size: 13px; }
.cols { display: flex; gap: 28px; margin-top: 24px; flex-wrap: wrap; }
.col-dial { flex: 0 0 300px; } .col-units { flex: 1 1 380px; min-width: 300px; }
table { width: 100%; border-collapse: collapse; background: #fff;
  border: 1px solid var(--grid); font-size: 12.5px; }
th { text-align: left; font-size: 11px; text-transform: uppercase;
  letter-spacing: 0.08em; color: var(--muted); }
th, td { padding: 6px 10px; border-bottom: 1px solid var(--grid); }
.overflow { overflow-x: auto; }
.chip { display: inline-block; padding: 1px 8px; border-radius: 3px;
  font-size: 11px; font-weight: 600; }
.chip.current { color: var(--ok); background: #E7F2EB; }
.chip.warn { color: var(--warn); background: #F7EEDD; }
.chip.broken { color: var(--broken); background: #F6E4E4; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px; }
.card { background: #fff; border: 1px solid var(--grid); padding: 12px 14px;
  border-top: 3px solid var(--ink); }
.card.project-scope { border-top-color: var(--warn); }
.card .hl { font-family: "SF Mono", Menlo, monospace; font-size: 11px;
  color: var(--muted); }
.card h3 { font-size: 14px; margin: 4px 0 6px; }
.card .instruction { font-size: 13px; }
.card .lineage { margin-top: 8px; font-size: 11.5px; color: var(--muted);
  border-top: 1px dashed var(--grid); padding-top: 6px; }
.cat { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--canon); font-weight: 700; }
.ledger { background: #fff; border: 1px solid var(--grid); }
.ledger-row { display: flex; gap: 16px; padding: 8px 14px; font-size: 12.5px;
  border-bottom: 1px solid var(--grid); align-items: baseline; }
.ledger-row .sha { color: var(--canon); }
.ledger-row .proj { font-weight: 700; }
.ledger-row .arrow { color: var(--muted); }
.empty { color: var(--muted); font-size: 13px; font-style: italic; padding: 10px 0; }
.runs li { font-family: "SF Mono", Menlo, monospace; font-size: 12.5px;
  padding: 5px 0; border-bottom: 1px dashed var(--grid); list-style: none; }
.runs .goal { display: block; font-family: system-ui, sans-serif;
  color: var(--muted); font-size: 12px; margin-top: 2px; }
.reflect { background: #fff; border: 1px solid var(--grid);
  padding: 10px 14px 10px 34px; font-size: 13px; }
.reflect li { padding: 5px 0; border-bottom: 1px dashed var(--grid); }
.reflect li:last-child { border-bottom: none; }
.reflect li.recursive { border-left: 3px solid var(--canon); padding-left: 8px;
  margin-left: -11px; }
.dial-caption { font-size: 12px; color: var(--muted); margin-top: 8px; }
footer { margin-top: 48px; font-size: 11px; color: var(--muted);
  border-top: 1px solid var(--grid); padding-top: 10px; }
@media (max-width: 720px) { .col-dial { flex-basis: 100%; } }
"""

PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harness — {project}</title>
<style>{css}</style>
</head>
<body>
<div class="wrap">
  <header class="masthead">
    <h1>Harness · {project}</h1>
    <div class="meta mono">generated {generated}<br>last synced canonical {canonical_commit} · now {canonical_note}</div>
  </header>
  <div class="statebar">{state}</div>

  <div class="cols">
    <div class="col-dial">
      <h2>Goal loop</h2>
      {dial}
      <div class="dial-caption">The {step_count} steps of PROCESS.md's core loop. A lit
      segment marks the step STATE.md reports for the active run.</div>
    </div>
    <div class="col-units">
      <h2>Sync units</h2>
      <div class="overflow"><table>
        <tr><th>unit</th><th>type</th><th>host</th><th>state</th></tr>
        {unit_rows}
      </table></div>
    </div>
  </div>

  <h2>Self-improvement · the mechanism</h2>
  <p class="dial-caption">SELF-IMPROVE.md, the reflection every goal ends with. Step
  4 is the recursive one: it rewrites these very instructions.</p>
  <ol class="reflect">{reflect_rows}</ol>

  <h2>Self-improvement · promote ledger</h2>
  <p class="dial-caption">Every <span class="mono">harness: promote</span> commit in
  the canonical history this install can reach — the outer loop's full exchange
  record, newest first{ledger_scope_note}.</p>
  <div class="ledger">{ledger_rows}</div>

  <h2>Playbook · durable ({durable_count})</h2>
  <div class="cards">{durable_cards}</div>

  <h2>Playbook · this project ({project_count})</h2>
  <div class="cards">{project_cards}</div>

  <h2>Run journals</h2>
  <ul class="runs">{run_rows}</ul>

  <footer class="mono">install {root} · regenerate with: .harness/bin/harness dashboard</footer>
</div>
</body>
</html>
"""
