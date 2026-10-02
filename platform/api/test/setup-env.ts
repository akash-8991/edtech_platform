// Defaults for the test environment. Dedicated suites (security) switch individual controls on explicitly.
process.env.RATE_LIMIT_DISABLED = '1';
process.env.SESSION_CACHE_MS = process.env.SESSION_CACHE_MS ?? '0'; // sessions revoked in a test take effect immediately
process.env.STRUCT_CACHE_MS = '0'; // tests mutate published fixtures directly
process.env.PRIVACY_ENFORCE_CONSENT = '0'; process.env.ACCESSIBILITY_ENFORCE = '0';
