<script lang="ts">
	// The site's users, for its admins: add someone, make or unmake an admin, remove someone. The host
	// checks every change again (functions/lib/users.ts), so this page only saves a round trip. After
	// an add or a removal the host brings the Cloudflare Access group in step with the list; when it
	// cannot, the change is still saved and the page says so, offering Sync with Access.
	import { tick } from 'svelte';
	import { accessStatus, addUser, listUsers, removeUser, setAdmin, syncAccess, type AccessSync, type UserRow } from '#lib/users/api.ts';
	import { session } from '#lib/state/session.svelte.ts';

	type Message = { level: 'info' | 'warning' | 'error'; text: string };

	let users = $state<UserRow[] | null>(null);
	let message = $state<Message | null>(null);
	let email = $state('');
	let asAdmin = $state(false);
	let busy = $state(false);
	/** The user whose removal is waiting to be confirmed. */
	let removing = $state<string | null>(null);
	/** The user whose Remove button takes focus back when it reappears, after Cancel. Not reactive. */
	let returnTo: string | null = null;
	let notice = $state<HTMLElement>();
	/** Whether the host keeps the Access group in step: null until known, or when it could not be asked. */
	let accessConfigured = $state<boolean | null>(null);

	const focus = (el: HTMLElement) => el.focus();
	const focusIfReturning = (email: string) => (el: HTMLElement) => {
		if (returnTo !== email) return;
		returnTo = null;
		el.focus();
	};

	function cancel(email: string) {
		returnTo = email;
		removing = null;
	}

	const me = $derived(session.me);
	const date = (iso: string) => iso.slice(0, 10);

	async function act<T>(work: () => Promise<T>, done: string | ((r: T) => Message)) {
		busy = true;
		try {
			const r = await work();
			users = await listUsers();
			message = typeof done === 'string' ? { level: 'info', text: done } : done(r);
		} catch (e) {
			message = { level: 'error', text: (e as Error).message };
		} finally {
			busy = false;
		}
	}

	$effect(() => {
		if (me?.admin) {
			listUsers().then(
				(u) => (users = u),
				(e: Error) => (message = { level: 'error', text: e.message })
			);
			// Unknown stays null: Sync with Access is still offered, and says what is wrong if pressed.
			accessStatus().then(
				(s) => (accessConfigured = s.configured),
				() => (accessConfigured = null)
			);
		}
	});

	/** The outcome of an add or a removal, which is saved whatever Access said. */
	function afterChange(access: AccessSync, text: string): Message {
		if (access.state === 'failed') {
			return { level: 'warning', text: `Saved, but Cloudflare Access was not updated: ${access.reason}. Press Sync with Access.` };
		}
		accessConfigured = access.state === 'synced';
		return { level: 'info', text };
	}

	const sync = () =>
		act(syncAccess, ({ access, count }): Message => {
			if (access.state === 'failed') return { level: 'warning', text: `Cloudflare Access was not updated: ${access.reason}.` };
			accessConfigured = access.state === 'synced';
			return access.state === 'synced'
				? { level: 'info', text: `Cloudflare Access now sends a sign-in code to the ${count} ${count === 1 ? 'address' : 'addresses'} listed, and no one else.` }
				: { level: 'warning', text: 'Cloudflare Access is not set up to be kept in step with this list.' };
		});

	async function add(e: SubmitEvent) {
		e.preventDefault();
		const who = email.trim();
		await act(
			() => addUser(who, asAdmin),
			(r) => afterChange(r.access, `Added ${who.toLowerCase()}${asAdmin ? ' as an admin' : ''}. They can sign in now.`)
		);
		if (message?.level === 'info') {
			email = '';
			asAdmin = false;
		}
	}

	const toggleAdmin = (u: UserRow) =>
		act(() => setAdmin(u.email, !u.admin), u.admin ? `${u.email} is no longer an admin.` : `${u.email} is now an admin.`);

	async function remove(u: UserRow) {
		removing = null;
		await act(
			() => removeUser(u.email),
			({ access, sessions }): Message =>
				sessions?.state === 'failed'
					? {
							level: 'warning',
							text: `Removed ${u.email}. Cloudflare Access sends them no new sign-in code, but their open sessions could not be ended: ${sessions.reason}. The site refuses them on their next request all the same.`
						}
					: afterChange(access, `Removed ${u.email}. They can no longer open the site.`)
		);
		// The row, or at least its confirm, is gone: land on the outcome rather than the page body.
		await tick();
		notice?.focus();
	}
</script>

<section class="view prose">
	<h2>Users</h2>
	{#if !session.checked}
		<p class="muted" role="status">Loading…</p>
	{:else if session.expired}
		<div class="notice error" role="alert">Your sign-in has expired. Reload the page to sign in again.</div>
	{:else if !me}
		<p>This copy of the site has no user list. Users are managed on the hosted site, by its admins.</p>
	{:else if !me.admin}
		<p>You are signed in as {me.email}. Only an admin can manage users: ask one if someone needs to be added or removed.</p>
	{:else}
		<p>
			Only the people listed here can open the site. Each signs in with a one-time code sent to their email address. An admin can also add
			and remove users, and make other admins. The site keeps at least one admin, and you cannot remove yourself or your own admin rights.
			Every change is recorded with who made it.
		</p>

		<form class="controls" onsubmit={add}>
			<label>Email address
				<input type="email" required size="32" bind:value={email} autocomplete="off" />
			</label>
			<label class="check"><input type="checkbox" bind:checked={asAdmin} /> Admin</label>
			<button type="submit" disabled={busy}>Add user</button>
			{#if accessConfigured !== false}
				<button type="button" disabled={busy} onclick={sync}>Sync with Access</button>
			{/if}
		</form>

		{#if accessConfigured === false}
			<p class="notice">
				Cloudflare Access is not being kept in step with this list, because the host's Access group settings are missing. The site still
				lets in only the people listed here, but Access may send a sign-in code to anyone who asks.
			</p>
		{/if}

		{#if message}
			<div class="notice {message.level}" tabindex="-1" bind:this={notice} role={message.level === 'info' ? 'status' : 'alert'}>{message.text}</div>
		{/if}

		{#if users}
			<div class="tablewrap">
				<table aria-label="Users">
					<thead>
						<tr><th>Email address</th><th>Role</th><th>Added by</th><th>Added</th><th><span class="sr">Actions</span></th></tr>
					</thead>
					<tbody>
						{#each users as u (u.email)}
							{@const self = u.email === me.email}
							<tr>
								<td>{u.email}{self ? ' (you)' : ''}</td>
								<td>{u.admin ? 'Admin' : 'User'}</td>
								<td>{u.addedBy}</td>
								<td>{date(u.addedAt)}</td>
								<td class="actions">
									{#if self}
										<span class="muted">Another admin can change your account.</span>
									{:else if removing === u.email}
										<span>Remove {u.email}?</span>
										<button type="button" disabled={busy} onclick={() => remove(u)}>Yes, remove</button>
										<button type="button" onclick={() => cancel(u.email)} {@attach focus}>Cancel</button>
									{:else}
										<button type="button" disabled={busy} onclick={() => toggleAdmin(u)} aria-label="{u.admin ? 'Remove admin rights from' : 'Make admin'} {u.email}">
											{u.admin ? 'Remove admin rights' : 'Make admin'}
										</button>
										<button type="button" disabled={busy} onclick={() => (removing = u.email)} aria-label="Remove {u.email}" {@attach focusIfReturning(u.email)}>Remove</button>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else if !message}
			<p class="muted" role="status">Loading users…</p>
		{/if}
	{/if}
</section>

<style>
	.actions {
		display: flex;
		gap: 6px;
		align-items: center;
		flex-wrap: wrap;
	}
	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>
