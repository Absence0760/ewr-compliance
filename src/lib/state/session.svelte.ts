// Who is signed in, asked of the API once when the app starts. Null where the site has no user list
// (a copy served without the API).
//
// On the hosted site every file needs the CloudFront cookies the API issues for 15 minutes, so while
// the app is open the session renews them: every REFRESH_MS, and when the tab comes back after a
// while (a laptop asleep past the 15 minutes). A refresh also re-checks the list, so a removed user
// is sent to sign in. A 401 from the API means the session is over: the person goes to
// signin/?next=<here>. A 401 for a file (the edge's answer when only the file cookies ran out) gets one
// refresh first, through unauthorized().
import { refresh, signinUrl, whenSignedOut, whoAmI, type Me } from '#lib/users/api.ts';

/** Well inside the cookies' 15 minutes. */
export const REFRESH_MS = 10 * 60_000;
/** A tab that comes back after this long refreshes at once. */
export const STALE_MS = 5 * 60_000;
/** After a refresh that got no answer (a WAF limit, a 5xx, no network), try again this soon. */
export const RETRY_MS = 60_000;

class Session {
	me = $state<Me | null>(null);
	checked = $state(false);
	/** Set once the person is being sent to sign in. */
	leaving = $state(false);
	#last = 0;
	#timer: ReturnType<typeof setInterval> | null = null;
	#retry: ReturnType<typeof setTimeout> | null = null;

	async check() {
		const who = await whoAmI();
		if (who === 'signed-out') return this.signIn();
		this.me = who;
		this.checked = true;
		if (who) this.#keepAlive();
	}

	/**
	 * Renews the file cookies; false when the session is over (and on to sign-in), or when no answer
	 * came (and another try in RETRY_MS: the cookies are not renewed, so this is not a success).
	 */
	async refresh(): Promise<boolean> {
		const who = await refresh();
		if (who === 'signed-out') {
			this.signIn();
			return false;
		}
		if (who === 'error') {
			if (!this.#retry && !this.leaving) this.#retry = setTimeout(() => ((this.#retry = null), void this.refresh()), RETRY_MS);
			return false;
		}
		this.#last = Date.now();
		if (who) this.me = who;
		return true;
	}

	/** For a fetch that got 401: one refresh, then sign-in. True when the caller may try again. */
	unauthorized(): Promise<boolean> {
		return this.me ? this.refresh() : Promise.resolve(this.signIn());
	}

	/** `signedOut`: the person chose to sign out, so the sign-in page must not sign them straight back in. */
	signIn(signedOut = false): false {
		if (!this.leaving) {
			this.leaving = true;
			this.#stop();
			location.assign(signinUrl(location, signedOut));
		}
		return false;
	}

	#keepAlive() {
		this.#last = Date.now();
		this.#timer ??= setInterval(() => void this.refresh(), REFRESH_MS);
		document.addEventListener('visibilitychange', this.#onVisible);
	}

	#onVisible = () => {
		if (document.visibilityState === 'visible' && Date.now() - this.#last > STALE_MS) void this.refresh();
	};

	#stop() {
		if (this.#timer) clearInterval(this.#timer);
		if (this.#retry) clearTimeout(this.#retry);
		this.#timer = null;
		this.#retry = null;
		document.removeEventListener('visibilitychange', this.#onVisible);
	}
}

export const session = new Session();
whenSignedOut(() => session.signIn());
