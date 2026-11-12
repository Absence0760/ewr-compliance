// What the API is told (its environment, from infra/auth.tf) and what it reads at cold start
// (two Secrets Manager secrets). Nothing secret is in the environment: anyone allowed
// lambda:GetFunctionConfiguration reads it in clear, and the CI deploy role is (infra/oidc.tf).
//
//   USERS_TABLE              the DynamoDB table (auth-kit's single table)
//   SITE_DOMAIN              the site's hostname: the cookies' policy, and the only Origin allowed
//   MAIL_FROM                the sender, no-reply@<domain> (SES's FromAddress condition pins it)
//   SES_CONFIGURATION_SET    the configuration set every send goes through
//   CLOUDFRONT_KEY_PAIR_ID   the public key the cookies are signed for
//   CLOUDFRONT_PUBLIC_KEY    its PEM, to check the private key against at cold start
//   RUNTIME_SECRET_ARN       JSON: AUTH_CODE_KEY, AUTH_SESSION_KEY, ORIGIN_SECRET (Terraform writes it)
//   SIGNING_KEY_SECRET_ARN   the CloudFront private key, PEM (the operator puts it in, H7)
//   NODES_BUCKET             the admin node store's bucket (infra/nodes.tf), only with nodes_enabled;
//                            without it the /api/nodes routes are not there
//
// Fails closed: a missing or malformed value refuses every request with 503, naming the setting,
// never a value.
import { MIN_SECRET_LENGTH } from '@absence0760/auth-kit';

export interface Settings {
	tableName: string;
	domain: string;
	mailFrom: string;
	configurationSet: string;
	keyPairId: string;
	publicKey: string;
	runtimeSecretArn: string;
	signingKeySecretArn: string;
	/** Null when the node store is off. */
	nodesBucket: string | null;
}

export interface RuntimeSecrets {
	codeKey: string;
	sessionKey: string;
	originSecret: string;
}

export class ConfigError extends Error {
	override name = 'ConfigError';
}

type Env = Record<string, string | undefined>;

const SECRET_ARN = /^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$/;

export function readSettings(env: Env): Settings {
	const need = (name: string, ok: (v: string) => boolean) => {
		const v = env[name]?.trim() ?? '';
		if (!v || !ok(v)) throw new ConfigError(`${name} is missing or malformed`);
		return v;
	};
	return {
		tableName: need('USERS_TABLE', (v) => /^[A-Za-z0-9_.-]{3,255}$/.test(v)),
		domain: need('SITE_DOMAIN', (v) => /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(v)),
		mailFrom: need('MAIL_FROM', (v) => /^[^@\s<>]+@[^@\s<>]+$/.test(v)),
		configurationSet: need('SES_CONFIGURATION_SET', (v) => /^[A-Za-z0-9_-]{1,64}$/.test(v)),
		keyPairId: need('CLOUDFRONT_KEY_PAIR_ID', (v) => /^[A-Z0-9]{8,32}$/.test(v)),
		publicKey: need('CLOUDFRONT_PUBLIC_KEY', (v) => v.includes('-----BEGIN PUBLIC KEY-----')),
		runtimeSecretArn: need('RUNTIME_SECRET_ARN', (v) => SECRET_ARN.test(v)),
		signingKeySecretArn: need('SIGNING_KEY_SECRET_ARN', (v) => SECRET_ARN.test(v)),
		nodesBucket: env.NODES_BUCKET?.trim() ? need('NODES_BUCKET', (v) => /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(v)) : null
	};
}

/** The runtime secret's JSON: exactly these three keys, each at least auth-kit's minimum, all different. */
export function parseRuntimeSecret(raw: string): RuntimeSecrets {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// Not the parser's message: it can quote the text.
		throw new ConfigError('the runtime secret is not JSON');
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ConfigError('the runtime secret is not a JSON object');
	const o = parsed as Record<string, unknown>;
	const keys = ['AUTH_CODE_KEY', 'AUTH_SESSION_KEY', 'ORIGIN_SECRET'];
	const extra = Object.keys(o).filter((k) => !keys.includes(k));
	if (extra.length) throw new ConfigError(`the runtime secret holds unexpected keys: ${extra.join(', ')}`);
	for (const k of keys) {
		if (typeof o[k] !== 'string' || (o[k] as string).length < MIN_SECRET_LENGTH) throw new ConfigError(`the runtime secret's ${k} is missing or shorter than ${MIN_SECRET_LENGTH}`);
	}
	const s = { codeKey: o.AUTH_CODE_KEY as string, sessionKey: o.AUTH_SESSION_KEY as string, originSecret: o.ORIGIN_SECRET as string };
	if (new Set([s.codeKey, s.sessionKey, s.originSecret]).size !== 3) throw new ConfigError('the runtime secret reuses a value: each key must be different');
	return s;
}
