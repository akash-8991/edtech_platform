// Writes docs/openapi.json from the live route table and contracts. Run: npm run openapi
import 'reflect-metadata';
process.env.RATE_LIMIT_DISABLED = '1';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { buildOpenApi } from '../src/platform/openapi';
import { listRoutes } from '../src/platform/inventory';

(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile(); const app = mod.createNestApplication(); await app.init();
  const doc = buildOpenApi(listRoutes(app).map(({ controller, handler, ...r }) => ({ ...r, controller, handler })));
  writeFileSync(join(__dirname, '../../docs/openapi.json'), JSON.stringify(doc, null, 1) + '\n');
  console.log(`${Object.values(doc.paths).reduce((n: number, p: any) => n + Object.keys(p).length, 0)} operations written`); await app.close(); process.exit(0);
})();
