// The Lambda entry point (Function URL, payload 2.0): builds the API once per cold start, from the
// environment and two secrets, and translates the event. Everything that decides is in app.ts.
//
// The runtime secret (Terraform's, read once) holds the code and session keys and the origin
// secret. The signing key (the operator's, H7) is read on first use and cached for the life of
// the instance; until it is there, sign-in answers 503 and the next request tries again, so
// putting it in needs no redeploy.
import { createAuthKit } from '@absence0760/auth-kit';
import { dynamoStore } from '@absence0760/auth-kit/dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { NotReady, createApi, type Log, type RecordAudit } from './app.ts';
import { assertKeyPair, type Signer } from './cloudfront.ts';
import { ConfigError, parseRuntimeSecret, readSettings } from './config.ts';
import { error, type ApiRequest, type ApiResponse } from './http.ts';
import type { SendMail } from './mail.ts';
import { S3NodeBucket, createNodeStore } from './nodes.ts';

/**
 * The node store's audit rows, through auth-kit's recordAppAction (`app.node.put` and so on, the
 * actor re-checked as an admin in the same write). Until auth-kit has it, every node-store write
 * answers 503 and nothing is written, so no change can go unrecorded.
 *
 * TODO(auth-kit, Absence0760/auth-kit#6): once it is tagged and server/ is bumped to it, replace
 * the body with `auth.recordAppAction(actor, action, target)`, and drop the NotReady.
 */
export const recordAudit = (_auth: unknown): RecordAudit => async () => {
	throw new NotReady('auth-kit has no recordAppAction yet: the node store is not writable');
};

/** The fields of a Function URL event (payload format 2.0) this reads. */
export interface UrlEvent {
	rawPath?: string;
	rawQueryString?: string;
	headers?: Record<string, string | undefined>;
	cookies?: string[];
	body?: string;
	isBase64Encoded?: boolean;
	requestContext?: { http?: { method?: string } };
}

export interface UrlResult {
	statusCode: number;
	headers: Record<string, string>;
	cookies: string[];
	body: string;
}

/** One JSON line per event, which the auth.locked metric filter matches by name (infra/auth.tf). */
export const log: Log = (event, fields = {}) => console.log(JSON.stringify({ event, ...fields }));

export function toRequest(event: UrlEvent): ApiRequest {
	const headers: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(event.headers ?? {})) headers[k.toLowerCase()] = v;
	const raw = event.body ?? null;
	return {
		method: (event.requestContext?.http?.method ?? 'GET').toUpperCase(),
		path: event.rawPath ?? '/',
		query: new URLSearchParams(event.rawQueryString ?? ''),
		headers,
		// A Function URL moves the Cookie header into `cookies`.
		cookie: event.cookies?.length ? event.cookies.join('; ') : (headers.cookie ?? null),
		body: raw !== null && event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw
	};
}

export const toResult = (r: ApiResponse): UrlResult => ({ statusCode: r.status, headers: r.headers, cookies: r.cookies, body: r.body });

async function secretString(client: SecretsManagerClient, arn: string, what: string): Promise<string> {
	try {
		const out = await client.send(new GetSecretValueCommand({ SecretId: arn }));
		if (!out.SecretString) throw new NotReady(`${what} has no value`);
		return out.SecretString;
	} catch (e) {
		if (e instanceof NotReady) throw e;
		// The SDK's error names the ARN and the action, never a value; only its name is kept.
		throw new NotReady(`${what} could not be read (${e instanceof Error ? e.name : 'error'})`);
	}
}

function build() {
	const settings = readSettings(process.env);
	const secrets = new SecretsManagerClient({});
	const ses = new SESv2Client({});

	let signer: Promise<Signer> | null = null;
	const loadSigner = () =>
		(signer ??= secretString(secrets, settings.signingKeySecretArn, 'the signing-key secret')
			.then((privateKey) => {
				try {
					assertKeyPair(privateKey, settings.publicKey);
				} catch (e) {
					throw new NotReady((e as Error).message);
				}
				return { keyPairId: settings.keyPairId, privateKey };
			})
			.catch((e: unknown) => {
				signer = null; // try again on the next request
				throw e;
			}));

	const sendMail: SendMail = async (to, mail) => {
		await ses.send(
			new SendEmailCommand({
				FromEmailAddress: `EWR Compliance Measurement <${settings.mailFrom}>`,
				Destination: { ToAddresses: [to] },
				ConfigurationSetName: settings.configurationSet,
				Content: { Simple: { Subject: { Data: mail.subject, Charset: 'UTF-8' }, Body: { Text: { Data: mail.text, Charset: 'UTF-8' } } } }
			})
		);
	};

	return secretString(secrets, settings.runtimeSecretArn, 'the runtime secret').then((raw) => {
		const keys = parseRuntimeSecret(raw);
		const auth = createAuthKit({
			store: dynamoStore({ client: new DynamoDBClient({}), tableName: settings.tableName }),
			codeSecret: keys.codeKey,
			sessionKeys: [{ kid: 's1', secret: keys.sessionKey }],
			issuer: 'ewr-compliance'
		});
		const nodes = settings.nodesBucket ? { store: createNodeStore(new S3NodeBucket(settings.nodesBucket), () => Date.now()), recordAudit: recordAudit(auth) } : undefined;
		return createApi({ auth, domain: settings.domain, originSecret: keys.originSecret, signer: loadSigner, sendMail, log, ...(nodes ? { nodes } : {}) });
	});
}

let api: Promise<(req: ApiRequest) => Promise<ApiResponse>> | null = null;

export async function handler(event: UrlEvent): Promise<UrlResult> {
	try {
		api ??= build();
		return toResult(await (await api)(toRequest(event)));
	} catch (e) {
		api = null; // a secret put in later is picked up without a redeploy
		const reason = e instanceof ConfigError || e instanceof NotReady ? e.message : e instanceof Error ? e.name : 'error';
		log('api.not_ready', { reason });
		return toResult(error(503, 'Sign-in is not set up yet. Try again later.'));
	}
}
