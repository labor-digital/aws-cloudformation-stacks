import encryptionSdk from '@aws-crypto/client-node';
import { isAllowedEmail, parseAllowlist } from './allowlist.mjs';

const { buildClient, CommitmentPolicy, KmsKeyringNode } = encryptionSdk;
const { decrypt } = buildClient(CommitmentPolicy.REQUIRE_ENCRYPT_ALLOW_DECRYPT);
const keyArn = process.env.KMS_KEY_ARN;
const keyring = new KmsKeyringNode({ generatorKeyId: keyArn, keyIds: [keyArn] });

const allowedDomains = parseAllowlist(process.env.ALLOWED_DOMAINS ?? '');
const allowedEmails = parseAllowlist(process.env.ALLOWED_EMAILS ?? '');

const emailTitles = {
  en: {
    CustomEmailSender_Authentication: 'Your sign-in code',
    CustomEmailSender_SignUp: 'Confirm your email address',
    CustomEmailSender_ResendCode: 'Your confirmation code',
    CustomEmailSender_UpdateUserAttribute: 'Confirm your email change',
    CustomEmailSender_VerifyUserAttribute: 'Verify your email address',
  },
  de: {
    CustomEmailSender_Authentication: 'Dein Anmeldecode',
    CustomEmailSender_SignUp: 'Bestätige deine E-Mail-Adresse',
    CustomEmailSender_ResendCode: 'Dein Bestätigungscode',
    CustomEmailSender_UpdateUserAttribute: 'Bestätige deine E-Mail-Änderung',
    CustomEmailSender_VerifyUserAttribute: 'Verifiziere deine E-Mail-Adresse',
  },
};

const supportedTriggers = new Set(Object.keys(emailTitles.en));
const htmlEscapes = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => htmlEscapes[character]);
}

function buildHtml(language, title, code) {
  const productName = escapeHtml(process.env.MAIL_PRODUCT_NAME);
  const escapedTitle = escapeHtml(title);
  const escapedCode = escapeHtml(code);
  const instruction = language === 'de'
    ? 'Verwende den folgenden Einmalcode:'
    : 'Use the following one-time code:';

  return `<!doctype html><html lang="${language}"><body style="font-family:Arial,sans-serif;color:#222;line-height:1.5"><main style="max-width:560px;margin:32px auto;padding:24px"><h1>${productName}</h1><h2>${escapedTitle}</h2><p>${instruction}</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">${escapedCode}</p><p>${productName}</p></main></body></html>`;
}

function report(triggerSource, outcome) {
  console.info(JSON.stringify({
    metric: 'MailSenderInvocation',
    triggerSource,
    outcome,
    count: 1,
  }));
}

async function sendEmail(recipient, subject, html) {
  const authorization = Buffer.from(
    `${process.env.MAILJET_API_KEY}:${process.env.MAILJET_API_SECRET}`,
  ).toString('base64');
  const response = await fetch('https://api.mailjet.com/v3.1/send', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${authorization}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      Messages: [
        {
          From: {
            Email: process.env.MAIL_FROM_ADDRESS,
            Name: process.env.MAIL_FROM_NAME,
          },
          To: [{ Email: recipient }],
          Subject: subject,
          HTMLPart: html,
        },
      ],
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error('Mail provider request failed.');
  }

  const result = await response.json();
  if (result.Messages?.[0]?.Status !== 'success') {
    throw new Error('Mail provider rejected the message.');
  }
}

export const handler = async (event) => {
  const triggerSource = supportedTriggers.has(event?.triggerSource)
    ? event.triggerSource
    : 'unsupported';

  try {
    const language = process.env.MAIL_LANGUAGE;
    const title = emailTitles[language]?.[triggerSource];
    if (!title) {
      throw new Error('Unsupported email notification.');
    }

    const recipient = event?.request?.userAttributes?.email;
    if (!isAllowedEmail(recipient, allowedDomains, allowedEmails)) {
      report(triggerSource, 'blocked');
      return;
    }

    const encryptedCode = event?.request?.code;
    if (typeof encryptedCode !== 'string' || !encryptedCode) {
      throw new Error('Encrypted code is missing.');
    }

    const { plaintext } = await decrypt(keyring, Buffer.from(encryptedCode, 'base64'));
    const code = Buffer.from(plaintext).toString('utf8');
    if (!code) {
      throw new Error('Decrypted code is empty.');
    }

    await sendEmail(
      recipient.trim(),
      `${process.env.MAIL_PRODUCT_NAME}: ${title}`,
      buildHtml(language, title, code),
    );
    report(triggerSource, 'sent');
  } catch {
    report(triggerSource, 'error');
    throw new Error('Email delivery failed.');
  }
};
