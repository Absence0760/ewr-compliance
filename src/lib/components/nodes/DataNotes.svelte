<script lang="ts">
	import { app } from '#lib/state/app.svelte.ts';

	const GROUPS: Record<string, string> = {
		'ec-header': 'File header gives the wrong EC (values are a distinct run, so the file name is used)',
		'ec-copy': 'File is a copy of another EC, so its named EC is not available',
		'no-ewr-file': 'Node has no .tab or Revised .rul',
		variant: 'Alternate .tab files',
		'site-match': 'EWR sites joined to nodes by quaternary area and river',
		'estuary-match': 'Estuaries in the Reserve Gazette joined to nodes by name',
		'code-fix': 'Node codes corrected',
		'file-join': 'Files joined to a node under a different name',
		location: 'Node locations taken from a related point',
		'tec-conflict': 'Conflicting TEC in the source table',
		'file-skipped': 'Files not used',
		'no-location': 'No location'
	};

	const groups = $derived(
		Object.entries(GROUPS)
			.map(([kind, title]) => ({ kind, title, items: app.issues.filter((i) => i.kind === kind) }))
			.filter((g) => g.items.length)
	);
</script>

<h2>How the lines are built</h2>
<ul>
	<li><b>Reserve Desktop (.tab):</b> Drought EWR is the Low Flows Drought column and EWR Monthly Requirement is the Total Flows Maint. column.</li>
	<li>
		<b>Revised Reserve Desktop (.rul):</b> read from "Category Total Flow Assurance curves" in the section headed "EWR (low and
		total Flows) are constrained to be below Present Day Flows". EWR Monthly Requirement is the selected percentile (default 50th), and Drought EWR is
		the 90th or 99th percentile.
	</li>
	<li><b>Urgent action required:</b> 10% below EWR Monthly Requirement, for both methods.</li>
	<li>
		<b>Conversion:</b> Mm³ per month × 10⁶ ÷ (days in month × 86 400), using 28 days for February.
	</li>
	<li>
		<b>Historical Comparison:</b> mean monthly flow in Mm³ for the chosen period, converted the same way. Status compares the mean
		with the EWR. "Years ≥ EWR" counts how many individual years met it, because one flood year can lift a mean above the EWR.
	</li>
	<li><b>Real Time Comparison:</b> readings are averaged to daily flow and compared with the EWR for that calendar month.</li>
	<li>
		<b>EC default:</b> TEC, then REC, then PES if the first is missing. If no file exists for that EC the closest available is
		used, taking the higher category on a tie, and the panel says so.
	</li>
	<li>
		<b>Node locations:</b> open circles are nodes with no point in the location files, placed inside their quaternary.
	</li>
</ul>

<h2>Constructed _Con.txt files</h2>
<p>
	A <code>_Con.txt</code> file has the same layout as a .tab file and is read the same way, and its header is marked CONSTRUCTED.
	A plain .tab is used when one exists for the EC, otherwise the <code>_Con.txt</code>; the Method column on the nodes table
	shows which.
</p>
<p>
	A file matches the Reserve Gazette when its Total IFR % is within 0.6 percentage points of the gazetted EWR %. When the file in
	use does not match the gazette, the panel says so and names the file that does.
</p>

<h2>Sources</h2>
<ul>
	<li>TEC, PES and REC: {app.meta?.sources.ec}.</li>
	<li>Node locations: {app.meta?.sources.nodes}.</li>
	<li>{app.meta?.sources.quaternaries}. {app.meta?.sources.rivers}.</li>
	<li>Flow gauges: South African Hydropower Atlas (University of Pretoria and WRC), taken from DWS reports, loaded live.</li>
</ul>

<h2>Data review</h2>
{#each groups as g (g.kind)}
	<h3>{g.title} ({g.items.length})</h3>
	<table>
		<thead>
			<tr><th scope="col">Item</th><th scope="col">Detail</th></tr>
		</thead>
		<tbody>
			{#each g.items as i}
				<tr><td>{i.item}</td><td>{i.detail}</td></tr>
			{/each}
		</tbody>
	</table>
{/each}
