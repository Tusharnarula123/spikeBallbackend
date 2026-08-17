/**
 * Self-check for authorized-party parsing.
 * Run: npx ts-node -T src/auth/clerk.service.check.ts
 *
 * Getting this wrong 401s every authenticated request while public routes
 * keep working — which shows up in the UI as "every list is empty".
 */
import assert from 'assert';
import { parseAuthorizedParties } from './clerk.service';

const LOCAL = ['http://localhost:3000', 'http://127.0.0.1:3000'];

// Single origin.
assert.deepStrictEqual(
  parseAuthorizedParties('https://ouroundnet.vercel.app'),
  ['https://ouroundnet.vercel.app', ...LOCAL],
);

// Comma-separated — main.ts documents this for CORS, so auth must handle it.
assert.deepStrictEqual(
  parseAuthorizedParties('https://a.vercel.app,https://b.vercel.app'),
  ['https://a.vercel.app', 'https://b.vercel.app', ...LOCAL],
);

// Whitespace after commas is easy to leave in an env var.
assert.deepStrictEqual(
  parseAuthorizedParties('https://a.vercel.app, https://b.vercel.app'),
  ['https://a.vercel.app', 'https://b.vercel.app', ...LOCAL],
);

// Trailing slashes never match Clerk's `azp` claim, which is a bare origin.
assert.deepStrictEqual(
  parseAuthorizedParties('https://ouroundnet.vercel.app/'),
  ['https://ouroundnet.vercel.app', ...LOCAL],
);

// Unset / empty still allows local dev.
assert.deepStrictEqual(parseAuthorizedParties(undefined), LOCAL);
assert.deepStrictEqual(parseAuthorizedParties(''), LOCAL);
assert.deepStrictEqual(parseAuthorizedParties('  '), LOCAL);

// No duplicates when localhost is also named explicitly.
assert.deepStrictEqual(parseAuthorizedParties('http://localhost:3000'), LOCAL);

// Every entry must be a bare origin — a trailing slash anywhere breaks auth.
for (const url of ['https://a.app/,https://b.app/', 'https://a.app///']) {
  for (const party of parseAuthorizedParties(url)) {
    assert.ok(!party.endsWith('/'), `authorized party must not end with a slash: ${party}`);
  }
}

console.log('clerk authorized-parties: all checks passed');
