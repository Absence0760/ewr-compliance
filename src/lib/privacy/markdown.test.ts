import { describe, expect, it } from 'vitest';
import { inline, parseMarkdown } from './markdown.ts';

describe('inline', () => {
	it('keeps https and mailto links, and bold', () => {
		expect(inline('Write to [us](mailto:a@example.com) or see [the site](https://example.com/x), **now**.')).toEqual([
			{ kind: 'text', text: 'Write to ' },
			{ kind: 'link', text: 'us', href: 'mailto:a@example.com' },
			{ kind: 'text', text: ' or see ' },
			{ kind: 'link', text: 'the site', href: 'https://example.com/x' },
			{ kind: 'text', text: ', ' },
			{ kind: 'strong', text: 'now' },
			{ kind: 'text', text: '.' }
		]);
	});

	it.each(['javascript:alert`1`', 'JAVASCRIPT:alert`1`', 'data:text/html,x', 'http://example.com', '//example.com', 'vbscript:x'])(
		'shows a link to %s as its text alone',
		(href) => expect(inline(`a [b](${href}) c`)).toEqual([{ kind: 'text', text: 'a b c' }])
	);

	it('ends an address at its first ), so a script with brackets is still no link', () => {
		expect(inline('a [b](javascript:alert(1)) c')).toEqual([{ kind: 'text', text: 'a b) c' }]);
	});

	it('leaves markup as text, never HTML', () => {
		expect(inline('<img src=x onerror=alert(1)> & <b>')).toEqual([{ kind: 'text', text: '<img src=x onerror=alert(1)> & <b>' }]);
	});
});

describe('parseMarkdown', () => {
	it('reads headings, paragraphs and lists', () => {
		const md = '# Title\n\nOne line\nrun on.\n\n## Part\n\n- first\n  carried on\n- second\n\n1. one\n2) two\n\n### Small\nlast';
		expect(parseMarkdown(md)).toEqual([
			{ kind: 'heading', level: 2, content: [{ kind: 'text', text: 'Title' }] },
			{ kind: 'para', content: [{ kind: 'text', text: 'One line run on.' }] },
			{ kind: 'heading', level: 3, content: [{ kind: 'text', text: 'Part' }] },
			{ kind: 'list', ordered: false, items: [[{ kind: 'text', text: 'first carried on' }], [{ kind: 'text', text: 'second' }]] },
			{ kind: 'list', ordered: true, items: [[{ kind: 'text', text: 'one' }], [{ kind: 'text', text: 'two' }]] },
			{ kind: 'heading', level: 4, content: [{ kind: 'text', text: 'Small' }] },
			{ kind: 'para', content: [{ kind: 'text', text: 'last' }] }
		]);
	});

	it('ends a list at an unindented line, and a paragraph at a list', () => {
		expect(parseMarkdown('Before\n- item\nAfter').map((b) => b.kind)).toEqual(['para', 'list', 'para']);
	});

	it('takes Windows line ends, and nothing from an empty file', () => {
		expect(parseMarkdown('# A\r\n\r\nB\r\n')).toHaveLength(2);
		expect(parseMarkdown('')).toEqual([]);
	});

	it('reads #### as a paragraph, not a heading', () => {
		expect(parseMarkdown('#### Four')).toEqual([{ kind: 'para', content: [{ kind: 'text', text: '#### Four' }] }]);
	});
});
