// The privacy notice, read from static/data/privacy.md. Its text is not in this repo: the real notice
// comes from the private repo with the data, and the sample has a made-up one. Read once, on its page.
import { asset } from '$app/paths';
import { parseMarkdown, type Block } from './markdown.ts';

class Notice {
	blocks = $state.raw<Block[] | null>(null);
	error = $state('');
	private started = false;

	async load(): Promise<void> {
		if (this.started) return;
		this.started = true;
		this.error = '';
		try {
			const res = await fetch(asset('data/privacy.md' as never));
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			this.blocks = parseMarkdown(await res.text());
		} catch (e) {
			// Not kept, so the next visit tries again.
			this.started = false;
			this.error = `The privacy notice could not be loaded: ${(e as Error).message}`;
		}
	}
}

export const notice = new Notice();
