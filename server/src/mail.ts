// The sign-in email. Plain text only: nothing in it can be rendered or tracked. It names the site
// and the code, and says what to do if the person didn't ask. The code is the only factor, so the
// email carries no link that signs anyone in.

export interface CodeEmail {
	subject: string;
	text: string;
}

export function codeEmail(code: string, domain: string, minutes: number): CodeEmail {
	return {
		subject: `Your sign-in code for EWR Compliance Measurement: ${code}`,
		text: [
			`Your sign-in code for EWR Compliance Measurement (https://${domain}/) is:`,
			'',
			`    ${code}`,
			'',
			`It works once, for ${minutes} minutes. Type it on the sign-in page.`,
			'',
			'If you did not ask to sign in, you can ignore this email: nobody can sign in without the code.',
			'Never give this code to anyone, including someone who says they run the site.',
			''
		].join('\n')
	};
}

/** Sends one email; the API's SES client in production (lambda.ts), a recorder in tests. */
export type SendMail = (to: string, mail: CodeEmail) => Promise<void>;
