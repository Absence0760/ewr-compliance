// Who is signed in, asked of the host once when the app starts. Null where the site has no user list,
// and `expired` when the host says the sign-in has run out.
import { whoAmI, type Me } from '#lib/users/api.ts';

class Session {
	me = $state<Me | null>(null);
	expired = $state(false);
	checked = $state(false);

	async check() {
		const who = await whoAmI();
		this.expired = who === 'expired';
		this.me = who === 'expired' ? null : who;
		this.checked = true;
	}
}

export const session = new Session();
