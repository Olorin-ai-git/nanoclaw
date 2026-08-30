"""The fleet index markup, kept apart from the code that fills it.

Markup and the logic that computes what goes in it change for different
reasons and at different rates; splitting them keeps a template edit from
reading as a behaviour change in review.
"""

INDEX = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harness — fleet</title>
<style>{css}</style>
</head>
<body>
<div class="wrap">
  <header class="masthead">
    <h1>Harness · Fleet</h1>
    <div class="meta mono">generated {generated}<br>{project_count} project(s) across {root_count} root(s)</div>
  </header>

  <div class="summary">
    <div class="stat"><span class="n">{project_count}</span><span class="k">projects</span></div>
    <div class="stat"><span class="n">{all_current}</span><span class="k">verified current</span></div>
    <div class="stat{drift_class}"><span class="n">{drifting}</span><span class="k">needing update</span></div>
    <div class="stat{broken_class}"><span class="n">{broken}</span><span class="k">broken</span></div>
    <div class="stat{unverified_class}"><span class="n">{unverified}</span><span class="k">unverified</span></div>
    <div class="stat"><span class="n">{active}</span><span class="k">mid-goal</span></div>
    <div class="stat"><span class="n">{journals}</span><span class="k">run journals</span></div>
  </div>

  <h2>Installs</h2>
  <div class="overflow"><table>
    <tr><th>Project</th><th>Units</th><th>Step</th><th>Journals</th><th>State</th></tr>
    {rows}
  </table></div>

  <h2>What this is, and what to run</h2>
  <p class="dial-caption">Every project carrying the Olorin harness reports the same
  four things: whether its managed units still match canonical, which step of the
  PROCESS loop its active goal sits on, how many goals it has journalled, and what
  its state line says. A project name links to its own full dashboard — the same page
  <span class="mono">harness dashboard</span> writes inside the project.</p>
  <table class="legend">
    <tr><th>State</th><th>What it means</th><th>What to run</th></tr>
    <tr><td><span class="chip current">current</span></td>
      <td>Every managed unit matches canonical, and that was actually checked.</td>
      <td class="mono">nothing</td></tr>
    <tr><td><span class="chip warn">stale</span></td>
      <td>A unit is behind canonical. Normal right after canonical moves — one
        change there makes every install stale at once.</td>
      <td class="mono">harness update --target &lt;repo&gt;</td></tr>
    <tr><td><span class="chip broken">broken</span></td>
      <td>The install, or one of its units, could not be read. An update cannot
        fix this — a file is missing or unreadable.</td>
      <td class="mono">harness doctor --target &lt;repo&gt;</td></tr>
    <tr><td><span class="chip warn">unverified</span></td>
      <td>The canonical home was unreachable, so no staleness comparison ran.
        These units are not known to be current; they are unchecked.</td>
      <td class="mono">harness status --target &lt;repo&gt;</td></tr>
  </table>

  <div class="foot mono">Rendered from {root_list} · canonical {canonical_commit}</div>
</div>
</body>
</html>
"""

PROJECT_CRUMB = '<div class="crumb"><a href="{href}">&larr; all projects</a></div>'
