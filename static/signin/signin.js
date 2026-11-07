// The sign-in page: an address, then the code from the email, then back where the person was going.
// Plain JavaScript with no build step, because this page must load without the app (served from
// /signin/, the one path outside the sign-in). The API is server/src/app.ts.
import { safeNext } from '/signin/next.js';

const $ = (id) => document.getElementById(id);
const emailStep = $('email-step');
const codeStep = $('code-step');
const emailInput = $('email');
const codeInput = $('code');
const statusBox = $('status');
const errorBox = $('error');

const target = safeNext(new URLSearchParams(location.search).get('next'), location.origin, location.pathname + location.search);
let address = '';

function say(text) {
	errorBox.textContent = '';
	statusBox.textContent = text;
}

function fail(text, focus) {
	statusBox.textContent = '';
	errorBox.textContent = text;
	(focus ?? errorBox).focus();
}

function busy(form, on) {
	for (const b of form.querySelectorAll('button')) b.disabled = on;
}

async function post(path, body) {
	const res = await fetch(path, {
		method: 'POST',
		credentials: 'same-origin',
		headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
		body: JSON.stringify(body)
	});
	let data = null;
	if ((res.headers.get('Content-Type') ?? '').includes('application/json')) data = await res.json().catch(() => null);
	return { status: res.status, retryAfter: Number(res.headers.get('Retry-After')) || 0, error: data && typeof data.error === 'string' ? data.error : null };
}

const go = () => location.replace(new URL(target, location.origin).href);

const wait = (seconds) => (seconds >= 90 ? `${Math.ceil(seconds / 60)} minutes` : `${seconds} seconds`);

function showEmail() {
	codeStep.hidden = true;
	emailStep.hidden = false;
	codeInput.value = '';
	emailInput.focus();
}

function showCode() {
	emailStep.hidden = true;
	codeStep.hidden = false;
	codeInput.focus();
}

async function sendCode(form) {
	busy(form, true);
	try {
		const r = await post('/api/auth/code', { email: address });
		if (r.status === 202) {
			say(`If ${address} is on the list, a code is on its way to it. It can take a minute to arrive.`);
			showCode();
		} else if (r.status === 429) {
			fail(`${r.error ?? 'Too many requests.'} Try again in ${wait(r.retryAfter || 60)}.`, form === emailStep ? emailInput : codeInput);
		} else if (r.status === 400) {
			fail(r.error ?? 'Check the address.', emailInput);
			showEmail();
		} else {
			fail(r.error ?? `Sign-in is not available just now (HTTP ${r.status}). Try again in a minute.`);
		}
	} catch {
		fail('Could not reach the site. Check your connection and try again.');
	} finally {
		busy(form, false);
	}
}

emailStep.addEventListener('submit', (e) => {
	e.preventDefault();
	address = emailInput.value.trim();
	if (!address || !emailInput.checkValidity()) {
		fail('Enter a whole email address, such as name@example.com.', emailInput);
		return;
	}
	void sendCode(emailStep);
});

codeStep.addEventListener('submit', async (e) => {
	e.preventDefault();
	const code = codeInput.value.replace(/\s+/g, '');
	if (!/^[0-9]{6}$/.test(code)) {
		fail('Enter the 6 digits from the email.', codeInput);
		return;
	}
	busy(codeStep, true);
	try {
		const r = await post('/api/auth/verify', { email: address, code });
		if (r.status === 200) {
			say('Signed in. Opening the site…');
			go();
			return;
		}
		if (r.status === 429) fail(`${r.error ?? 'Too many wrong codes.'} Try again in ${wait(r.retryAfter || 60)}.`, codeInput);
		else if (r.status === 400) fail(r.error ?? 'That code is wrong or has expired.', codeInput);
		else fail(r.error ?? `Sign-in is not available just now (HTTP ${r.status}). Try again in a minute.`);
	} catch {
		fail('Could not reach the site. Check your connection and try again.');
	} finally {
		busy(codeStep, false);
	}
});

$('resend').addEventListener('click', () => void sendCode(codeStep));
$('other').addEventListener('click', () => {
	say('');
	showEmail();
});

// Someone whose session is still live (a link from elsewhere, or files that ran out) needs no code:
// the refresh re-checks the list and renews the file cookies. Only at /signin/ itself: served by
// CloudFront for a 403 at another address, going back there could 403 again, in a loop. And not
// straight after a sign-out, which would undo it if the session outlived the sign-out.
const params = new URLSearchParams(location.search);
const atSignin = location.pathname === '/signin/' || location.pathname === '/signin/index.html';
if (atSignin && !params.has('signedout')) {
	post('/api/auth/refresh', {})
		.then((r) => (r.status === 200 ? go() : showEmail()))
		.catch(() => showEmail());
} else {
	if (params.has('signedout')) say('You are signed out.');
	showEmail();
}
