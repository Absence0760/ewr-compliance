import { describe, expect, it } from 'vitest';
import { ConfigError, parseRuntimeSecret, readSettings } from './config.ts';

const ARN = 'arn:aws:secretsmanager:af-south-1:000000000000:secret:ewr-compliance/auth-runtime-AbCdEf';
const ENV = {
	USERS_TABLE: 'ewr-compliance-users',
	SITE_DOMAIN: 'ewr.example.test',
	MAIL_FROM: 'no-reply@ewr.example.test',
	SES_CONFIGURATION_SET: 'ewr-compliance',
	CLOUDFRONT_KEY_PAIR_ID: 'K2JCJMDEHXQW5F',
	CLOUDFRONT_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----',
	RUNTIME_SECRET_ARN: ARN,
	SIGNING_KEY_SECRET_ARN: ARN.replace('auth-runtime', 'cloudfront-signing-key')
};
const k = (c: string) => c.repeat(40);

describe('settings', () => {
	it('reads every setting', () => {
		expect(readSettings(ENV)).toMatchObject({ tableName: 'ewr-compliance-users', domain: 'ewr.example.test', keyPairId: 'K2JCJMDEHXQW5F' });
	});

	it('fails closed on any missing or malformed setting, naming it', () => {
		for (const name of Object.keys(ENV)) {
			expect(() => readSettings({ ...ENV, [name]: undefined }), name).toThrow(new ConfigError(`${name} is missing or malformed`));
		}
		expect(() => readSettings({ ...ENV, SITE_DOMAIN: 'https://ewr.example.test' })).toThrow(/SITE_DOMAIN/);
		expect(() => readSettings({ ...ENV, RUNTIME_SECRET_ARN: 'arn:aws:s3:::bucket' })).toThrow(/RUNTIME_SECRET_ARN/);
	});
});

describe('the runtime secret', () => {
	it('takes exactly the three keys, each long enough and different', () => {
		expect(parseRuntimeSecret(JSON.stringify({ AUTH_CODE_KEY: k('a'), AUTH_SESSION_KEY: k('b'), ORIGIN_SECRET: k('c') }))).toEqual({ codeKey: k('a'), sessionKey: k('b'), originSecret: k('c') });
	});

	it('refuses anything else, without quoting it', () => {
		const bad = [
			'nope ' + k('s'),
			'[]',
			JSON.stringify({ AUTH_CODE_KEY: k('a'), AUTH_SESSION_KEY: k('b') }),
			JSON.stringify({ AUTH_CODE_KEY: k('a'), AUTH_SESSION_KEY: k('b'), ORIGIN_SECRET: k('c'), EXTRA: 'x' }),
			JSON.stringify({ AUTH_CODE_KEY: 'short', AUTH_SESSION_KEY: k('b'), ORIGIN_SECRET: k('c') }),
			JSON.stringify({ AUTH_CODE_KEY: k('a'), AUTH_SESSION_KEY: k('a'), ORIGIN_SECRET: k('c') })
		];
		for (const raw of bad) {
			expect(() => parseRuntimeSecret(raw)).toThrow(ConfigError);
			try {
				parseRuntimeSecret(raw);
			} catch (e) {
				expect((e as Error).message).not.toMatch(/sssss|aaaaa|bbbbb|ccccc/);
			}
		}
	});
});
