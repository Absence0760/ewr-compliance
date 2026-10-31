// Which EC, method and file a node uses. Pure, so the rules are unit tested.
import { LADDER, nearestEc, parseTab } from './parsers.ts';
import type { EcBasis, EwrNode, FlowBasis, NodeChoices, NodeFile, NodeView, Notice, ResolvedLines } from './types.ts';

const ALL_REVISED = ['A', 'A/B', 'B', 'B/C', 'C', 'C/D', 'D'];
const KIND_ORDER = ['revised', 'tab', 'con', 'rul', 'mrv', 'hydro'];
const byLadder = (a: string, b: string) => LADDER.indexOf(a) - LADDER.indexOf(b);

export function allFiles(n: EwrNode, upload?: { name: string }): NodeFile[] {
	const list: NodeFile[] = upload
		? [{ name: upload.name, kind: 'revised', ec: '', basis: '', uploaded: true }, ...n.files]
		: n.files;
	return [...list].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

export function basisOf(n: EwrNode, choices?: NodeChoices): FlowBasis {
	if (n.basin !== 'Olifants-Doring') return '';
	if (choices?.basis) return choices.basis;
	const hasCum = n.files.some(
		(f) => (f.kind === 'tab' || f.kind === 'con') && (f.basis === 'cum' || f.basis === 'both')
	);
	return hasCum ? 'cum' : 'inc';
}

function candidates(n: EwrNode, basis: FlowBasis): NodeFile[] {
	return n.files.filter(
		(f) => (f.kind === 'tab' || f.kind === 'con') && f.ec && (!basis || f.basis === basis || f.basis === 'both')
	);
}

/** The chosen category if recorded, otherwise the next of TEC, REC, PES that is. */
export function targetEc(n: EwrNode, basis: FlowBasis, ecBasis: EcBasis): { ec: string; source: string } {
	const tec = basis === 'inc' ? n.tecInc || n.tec : n.tec;
	const values: Record<EcBasis, string> = { TEC: tec, REC: n.rec, PES: n.pes };
	const order: EcBasis[] = [ecBasis, ...(['TEC', 'REC', 'PES'] as EcBasis[]).filter((k) => k !== ecBasis)];
	const hit = order.find((k) => values[k]);
	return { ec: hit ? values[hit] : '', source: hit ?? '' };
}

export function resolveView(n: EwrNode, ecBasis: EcBasis, choices: NodeChoices = {}, uploaded = false): NodeView {
	const basis = basisOf(n, choices);
	const hasRevised = n.hasRevised || uploaded;
	const cand = candidates(n, basis);
	const avail = [...new Set([...cand.map((f) => f.ec), ...(hasRevised ? ALL_REVISED : [])])].sort(byLadder);
	const target = targetEc(n, basis, ecBasis);
	const ec = choices.ec && avail.includes(choices.ec) ? choices.ec : nearestEc(target.ec, avail);
	// Plain .tab first, then alternates, then constructed files.
	const sources = cand
		.filter((f) => f.ec === ec)
		.sort((a, b) => Number(!!a.variant) - Number(!!b.variant) || Number(a.kind === 'con') - Number(b.kind === 'con'));
	const wantsRevised = choices.method === 'revised' && hasRevised;
	const method = wantsRevised || (!sources.length && hasRevised) ? 'revised' : 'tab';
	const source = sources.find((f) => f.name === choices.source) ?? sources[0] ?? null;
	return { basis, cand, avail, target, ec, sources, method, source, hasRevised };
}

const shortName = (name: string) => name.replace(/^(Inc|Cum)\//, '');

/** Files whose Total IFR % agrees with the gazetted EWR %. */
export function gazetteMatches(n: EwrNode, v: NodeView, texts: Record<string, string>): NodeFile[] {
	if (!n.gazPct || Number.isNaN(n.gazPct)) return [];
	const pool = n.basin === 'Olifants-Doring' ? v.cand : n.files.filter((f) => f.kind === 'tab');
	return pool.filter((f) => {
		const pct = parseTab(texts[f.name]).totalPct;
		return pct !== null && Math.abs(pct - (n.gazPct as number)) <= 0.6;
	});
}

export function buildNotices(
	n: EwrNode,
	v: NodeView,
	ecBasis: EcBasis,
	choices: NodeChoices,
	lines: ResolvedLines | null,
	texts: Record<string, string> | null
): Notice[] {
	const out: Notice[] = [];
	if (!v.avail.length) {
		out.push({
			level: 'warn',
			text: n.files.length
				? 'This node has flow series only: no .tab or Revised .rul file, so no EWR can be drawn. Add a Revised .rul to use it.'
				: 'No EWR files were supplied for this node.'
		});
		if (n.ewrNote) out.push({ level: 'info', text: n.ewrNote });
	}
	if (n.lon === null) {
		out.push({ level: 'info', text: 'Not on the map: the supplied data gives this node no coordinates or quaternary.' });
	} else if (n.approx) {
		out.push({ level: 'info', text: `Location approximate: no point was supplied for this node, so it is placed inside quaternary ${n.quat}.` });
	}
	const picked = !!choices.ec;
	if (v.ec && v.target.ec && v.ec !== v.target.ec && !picked) {
		out.push({
			level: 'warn',
			text: `The ${v.target.source} is ${v.target.ec} but no file exists for that EC. Showing the closest available, ${v.ec}.`
		});
	}
	if (v.ec && !v.target.ec) {
		out.push({ level: 'warn', text: `No TEC, REC or PES is recorded for this node. Showing ${v.ec}, the first available EC.` });
	}
	if (v.ec && v.target.source && v.target.source !== ecBasis && !picked) {
		out.push({ level: 'info', text: `No ${ecBasis} is recorded for this node, so its ${v.target.source} is the default.` });
	}
	if (v.method === 'tab' && v.source?.kind === 'con' && !v.sources.some((f) => f.kind === 'tab')) {
		out.push({ level: 'info', text: `Using the constructed file ${shortName(v.source.name)}: no .tab exists for EC ${v.ec}.` });
	}
	if (lines?.tab && n.gazPct && v.method === 'tab' && texts) {
		const hits = gazetteMatches(n, v, texts);
		if (!hits.some((f) => f.name === v.source?.name)) {
			const named = [...new Set(hits.map((f) => `${shortName(f.name)} (EC ${f.ec})`))].join(', ');
			out.push({
				level: 'warn',
				text: `This file gives ${lines.tab.totalPct}% of nMAR; the Reserve Gazette gives ${n.gazPct}%.${named ? ` It matches ${named}.` : ''}`
			});
		}
	}
	return out;
}
