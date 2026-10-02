// Live connectivity check for configured providers (costs a few cents). Run: npm run ai:smoke
import { buildProviders } from '../src/ai/providers';
import { defaultRoutes } from '../src/ai/gateway';

(async () => {
  const providers = buildProviders();
  const names = Object.keys(providers) as ('anthropic' | 'openrouter')[];
  if (!names.length) { console.log('No providers configured: set ANTHROPIC_API_KEY and/or OPENROUTER_API_KEY (+ OPENROUTER_MODEL).'); process.exit(1); }
  const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
  for (const route of defaultRoutes().judge) {
    const p = providers[route.provider];
    if (!p) { console.log(`skip ${route.provider}:${route.model} (not configured)`); continue; }
    const t0 = Date.now();
    try {
      const r = await p.complete({ model: route.model, system: 'Reply with JSON only.', user: 'Return {"answer":"pong"}.', schema, schemaName: 'smoke', maxTokens: 500, effort: 'low' });
      console.log(`OK   ${route.provider}:${route.model} ${Date.now() - t0}ms tokens=${r.inputTokens}/${r.outputTokens}`, r.json);
    } catch (e: any) { console.log(`FAIL ${route.provider}:${route.model} ${e?.code ?? ''} ${e?.message}`); process.exitCode = 1; }
  }
})();
