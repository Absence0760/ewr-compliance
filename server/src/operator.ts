// The operator's actions, run from the workstation with the operator's own AWS profile, never
// through the site (tools/first-admin, tools/recover-admin, tools/erase-user):
//
//   first-admin    auth-kit bootstrapAdmin: the first admin, once, as one conditional transaction
//   recover-admin  auth-kit recoverAdmin: make a listed address an admin again and clear its lockout
//   erase-user     auth-kit eraseAddress: remove the address everywhere (POPIA)
//
// The address is asked for at a prompt, never taken as an argument, so it stays out of shell
// history. The table and the runtime secret's ARN come from the environment (the tools/ script
// reads them from `terraform output`); the keys are read from the runtime secret with the
// operator's credentials, because recover and erase must find the address's code and throttle,
// which are keyed by an HMAC under the code key. Nothing read is printed.
//
//   node src/operator.ts first-admin|recover-admin|erase-user
import { createInterface } from 'node:readline/promises';
import { createAuthKit, type AuthKit } from '@absence0760/auth-kit';
import { dynamoStore } from '@absence0760/auth-kit/dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { parseRuntimeSecret } from './config.ts';

export const COMMANDS = {
	'first-admin': {
		ask: 'The first admin\'s email address: ',
		confirm: (email: string) => `Make ${email} the site's first admin?`,
		run: async (auth: AuthKit, email: string) => {
			const r = await auth.bootstrapAdmin(email);
			return r.ok ? `${r.value.email} is the first admin. They can sign in now; add a second admin from the Users page.` : r;
		}
	},
	'recover-admin': {
		ask: 'The address to make an admin again: ',
		confirm: (email: string) => `Make ${email} an admin, and clear its sign-in lockout?`,
		run: async (auth: AuthKit, email: string) => {
			const r = await auth.recoverAdmin(email);
			return r.ok ? `${r.value.email} is an admin, and can ask for a code now. This is in the audit log.` : r;
		}
	},
	'erase-user': {
		ask: 'The address to erase: ',
		confirm: (email: string) => `Erase ${email}: remove them if listed and replace the address in every audit row? This can't be undone.`,
		run: async (auth: AuthKit, email: string) => {
			const r = await auth.eraseAddress(email);
			return r.ok
				? `Erased: ${r.value.removedUser ? 'the user was removed, and ' : ''}${r.value.rewritten} audit rows rewritten. Remove the address from SES's suppression list if it is there, and record the erasure. PITR keeps deleted items for 35 days.`
				: r;
		}
	}
} as const;

export type Command = keyof typeof COMMANDS;

export async function main(argv: string[], env: Record<string, string | undefined>): Promise<number> {
	const command = argv[0] as Command | undefined;
	if (!command || !(command in COMMANDS) || argv.length !== 1) {
		console.error(`Usage: node src/operator.ts ${Object.keys(COMMANDS).join('|')} (the address is asked for)`);
		return 2;
	}
	const table = env.EWR_USERS_TABLE?.trim();
	const secretArn = env.EWR_RUNTIME_SECRET_ARN?.trim();
	if (!table || !secretArn) {
		console.error('EWR_USERS_TABLE and EWR_RUNTIME_SECRET_ARN are needed: run it through tools/, which reads them from terraform output.');
		return 2;
	}
	if (!process.stdin.isTTY) {
		console.error('Run it from a terminal: the address is typed at a prompt.');
		return 2;
	}
	const c = COMMANDS[command];
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const email = (await rl.question(c.ask)).trim();
		const answer = (await rl.question(`${c.confirm(email)} Type yes: `)).trim();
		if (answer !== 'yes') {
			console.error('Not confirmed. Nothing changed.');
			return 1;
		}
		const secret = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: secretArn }));
		const keys = parseRuntimeSecret(secret.SecretString ?? '');
		const auth = createAuthKit({
			store: dynamoStore({ client: new DynamoDBClient({}), tableName: table }),
			codeSecret: keys.codeKey,
			sessionKeys: [{ kid: 's1', secret: keys.sessionKey }],
			issuer: 'ewr-compliance'
		});
		const out = await c.run(auth, email);
		if (typeof out === 'string') {
			console.log(out);
			return 0;
		}
		console.error(`Refused (${out.status}): ${out.error}`);
		return 1;
	} finally {
		rl.close();
	}
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env);
