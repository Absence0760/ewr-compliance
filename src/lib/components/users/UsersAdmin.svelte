<script lang="ts">
	// The site's users, for its admins: add someone, make or unmake an admin, remove someone. The API
	// checks every change again (server/, on auth-kit), so this page only saves a round trip. A removed
	// user's next call to the API is refused at once, and the files close to them within 15 minutes,
	// when the cookies the API issued run out.
	import { tick } from 'svelte';
	import { addUser, listUsers, removeUser, setAdmin, SignedOut, type UserRow } from '#lib/users/api.ts';
	import { session } from '#lib/state/session.svelte.ts';

	type Message = { level: 'info' | 'error'; text: string };

	let users = $state<UserRow[] | null>(null);
	let message = $state<Message | null>(null);
	let email = $state('');
	let asAdmin = $state(false);
	let busy = $state(false);
	/** The id of the user whose removal is waiting to be confirmed. */
	let removing = $state<string | null>(null);
	/** The user whose Remove button takes focus back when it reappears, after Cancel. Not reactive. */
	let returnTo: string | null = null;
	let notice = $state<HTMLElement>();

	const focus = (el: HTMLElement) => el.focus();
	const focusIfReturning = (id: string) => (el: HTMLElement) => {
		if (returnTo !== id) return;
		returnTo = null;
		el.focus();
	};

	function cancel(id: string) {
		returnTo = id;
		removing = null;
	}

	const me = $derived(session.me);
	const date = (iso: string) => iso.slice(0, 10);

	/** A signed-out answer is already on its way to the sign-in page: say nothing over it. */
	const problem = (e: unknown): Message | null => (e instanceof SignedOut ? null : { level: 'error', text: (e as Error).message });

	async function act<T>(work: () => Promise<T>, done: string) {
		busy = true;
		try {
			await work();
			users = await listUsers();
			message = { level: 'info', text: done };
		} catch (e) {
			message = problem(e);
		} finally {
			busy = false;
		}
	}

	$effect(() => {
		if (me?.admin) {
			listUsers().then(
				(u) => (users = u),
				(e) => (message = problem(e))
			);
		}
	});

	async function add(e: SubmitEvent) {
		e.preventDefault();
		const who = email.trim();
		await act(() => addUser(who, asAdmin), `Added ${who.toLowerCase()}${asAdmin ? ' as an admin' : ''}. They can sign in now.`);
		if (message?.level === 'info') {
			email = '';
			asAdmin = false;
		}
	}

	const toggleAdmin = (u: UserRow) =>
		act(() => setAdmin(u.id, !u.admin), u.admin ? `${u.email} is no longer an admin.` : `${u.email} is now an admin.`);

	async function remove(u: UserRow) {
		removing = null;
		await act(() => removeUser(u.id), `Removed ${u.email}. They are signed out now, and the site's files close to them within 15 minutes.`);
		// The row, or at least its confirm, is gone: land on the outcome rather than the page body.
		await tick();
		notice?.focus();
	}
</script>

<section class="view prose">
	<h2>Users</h2>
	{#if !session.checked}
		<p class="muted" role="status">Loading…</p>
	{:else if session.leaving}
		<p class="muted" role="status">Your sign-in has ended. Opening the sign-in page…</p>
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
		</form>

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
						{#each users as u (u.id)}
							{@const self = u.id === me.id}
							<tr>
								<td>{u.email}{self ? ' (you)' : ''}</td>
								<td>{u.admin ? 'Admin' : 'User'}</td>
								<td>{u.addedBy}</td>
								<td>{date(u.addedAt)}</td>
								<td class="actions">
									{#if self}
										<span class="muted">Another admin can change your account.</span>
									{:else if removing === u.id}
										<span>Remove {u.email}?</span>
										<button type="button" disabled={busy} onclick={() => remove(u)}>Yes, remove</button>
										<button type="button" onclick={() => cancel(u.id)} {@attach focus}>Cancel</button>
									{:else}
										<button type="button" disabled={busy} onclick={() => toggleAdmin(u)} aria-label="{u.admin ? 'Remove admin rights from' : 'Make admin'} {u.email}">
											{u.admin ? 'Remove admin rights' : 'Make admin'}
										</button>
										<button type="button" disabled={busy} onclick={() => (removing = u.id)} aria-label="Remove {u.email}" {@attach focusIfReturning(u.id)}>Remove</button>
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
