import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedEmail, parseAllowlist } from '../src/allowlist.mjs';

const allowedDomains = parseAllowlist('labor.digital');
const allowedEmails = parseAllowlist('a@fremd.de');

test('matches domains case-insensitively and exactly', () => {
  assert.equal(isAllowedEmail('Max.Mustermann@LABOR.digital', allowedDomains, allowedEmails), true);
  assert.equal(isAllowedEmail('a+test@labor.digital', allowedDomains, allowedEmails), true);
  assert.equal(isAllowedEmail('x@sub.labor.digital', allowedDomains, allowedEmails), false);
});

test('matches individual email addresses without alias normalization', () => {
  assert.equal(isAllowedEmail('A@FREMD.DE', allowedDomains, allowedEmails), true);
  assert.equal(isAllowedEmail('a+test@fremd.de', allowedDomains, allowedEmails), false);
});

test('rejects malformed addresses and empty allowlists', () => {
  for (const address of ['', 'no-at-sign', '@labor.digital', 'person@', null]) {
    assert.equal(isAllowedEmail(address, allowedDomains, allowedEmails), false);
  }
  assert.equal(isAllowedEmail('a@labor.digital', new Set(), new Set()), false);
});

test('trims and lowercases allowlist entries', () => {
  assert.deepEqual([...parseAllowlist(' LABOR.digital, A@FREMD.DE ')], ['labor.digital', 'a@fremd.de']);
});
