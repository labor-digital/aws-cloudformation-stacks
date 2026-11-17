export function parseAllowlist(value = '') {
  return new Set(
    value
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAllowedEmail(email, allowedDomains, allowedEmails) {
  if (typeof email !== 'string') {
    return false;
  }

  const normalized = email.trim().toLowerCase();
  const atIndex = normalized.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === normalized.length - 1) {
    return false;
  }

  const domain = normalized.slice(atIndex + 1);
  return allowedEmails.has(normalized) || allowedDomains.has(domain);
}
