// The little Markdown the privacy notice is written in, turned into blocks the page draws with Svelte's
// own elements. Nothing here becomes HTML: text is text, and a link keeps its address only when it is
// https: or mailto:, so a notice cannot run script whatever it holds. Pure.

export type Inline = { kind: 'text'; text: string } | { kind: 'strong'; text: string } | { kind: 'link'; text: string; href: string };

export type Block =
	| { kind: 'heading'; level: 2 | 3 | 4; content: Inline[] }
	| { kind: 'para'; content: Inline[] }
	| { kind: 'list'; ordered: boolean; items: Inline[][] };

/** The only addresses a link may have. Anything else is shown as its text alone. */
const SAFE_HREF = /^(https:\/\/|mailto:)[^\s]+$/i;

const TOKEN = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*/g;

/** Links `[text](address)` and bold `**text**`; everything else as written. */
export function inline(line: string): Inline[] {
	const out: Inline[] = [];
	const text = (t: string) => {
		if (!t) return;
		const last = out.at(-1);
		if (last?.kind === 'text') last.text += t;
		else out.push({ kind: 'text', text: t });
	};
	let at = 0;
	for (const m of line.matchAll(TOKEN)) {
		text(line.slice(at, m.index));
		if (m[1] !== undefined) {
			if (SAFE_HREF.test(m[2])) out.push({ kind: 'link', text: m[1], href: m[2] });
			else text(m[1]);
		} else out.push({ kind: 'strong', text: m[3] });
		at = m.index + m[0].length;
	}
	text(line.slice(at));
	return out;
}

const HEADING = /^(#{1,3})\s+(.*)$/;
const BULLET = /^[-*]\s+(.*)$/;
const NUMBERED = /^\d+[.)]\s+(.*)$/;

/**
 * Headings `#` to `###`, drawn one level down because the page's own title is its h1. Paragraphs are
 * lines run together up to a blank line. Lists are lines starting `-`, `*` or `1.`, and an indented
 * line carries on the item above it.
 */
export function parseMarkdown(source: string): Block[] {
	const blocks: Block[] = [];
	let para: string[] = [];
	let list: { ordered: boolean; items: string[] } | null = null;

	const flush = () => {
		if (para.length) blocks.push({ kind: 'para', content: inline(para.join(' ')) });
		if (list) blocks.push({ kind: 'list', ordered: list.ordered, items: list.items.map(inline) });
		para = [];
		list = null;
	};

	for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
		const line = raw.trim();
		if (!line) {
			flush();
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading) {
			flush();
			blocks.push({ kind: 'heading', level: (heading[1].length + 1) as 2 | 3 | 4, content: inline(heading[2]) });
			continue;
		}
		const bullet = BULLET.exec(line);
		const numbered = bullet ? null : NUMBERED.exec(line);
		const item = bullet ?? numbered;
		if (item) {
			const ordered = !!numbered;
			if (para.length || (list && list.ordered !== ordered)) flush();
			list ??= { ordered, items: [] };
			list.items.push(item[1]);
			continue;
		}
		if (list && /^\s/.test(raw)) {
			list.items[list.items.length - 1] += ` ${line}`;
			continue;
		}
		if (list) flush();
		para.push(line);
	}
	flush();
	return blocks;
}
