import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import contracts from './offline-effects.json' with { type: 'json' };
const ts = createRequire(import.meta.url)('../research-portal/node_modules/typescript/lib/typescript.js');

// Preview builds retain local UI effects. Live data effects are removed from
// App and its extracted hooks; only the standalone sample feed is retained.
export const offlineHookFiles = new Set([
  'useControllerCommands.ts', 'useControllerStatus.ts', 'usePortalAccess.ts',
  'usePortalReadings.ts', 'useSalesSupport.ts', 'usePortalCsv.ts',
]);
export function effectEdits(code, filename, live) {
  const source = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = [];
  for (const fn of source.statements.filter(ts.isFunctionDeclaration)) {
    for (const statement of fn.body?.statements ?? []) {
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression) || statement.expression.expression.getText(source) !== 'useEffect') continue;
      const text = statement.getText(source);
      if (!/supabase|loadPortalAccess|loadExperimentCatalog|loadHealthSnapshot|loadValveEvents|loadDeviceSyncState|loadSalesSupport|setData\(initialLoadState\)|refresh\(/.test(text)) continue;
      if (live && /exacth2o-dashboard-live|exacth2o-valve-events-live/.test(text)) continue;
      edits.push({ start: statement.getStart(source), end: statement.end, text });
    }
  }
  return edits;
}
export function effectContract(edits) {
  return {
    count: edits.length,
    sha256: createHash('sha256').update(JSON.stringify(edits.map(e => e.text.replace(/\s+/g, ' ')))).digest('hex'),
  };
}
export function stripOfflineEffects(code, filename, live) {
  const edits = effectEdits(code, filename, live);
  const expected = contracts[live ? 'standalone' : 'embedded'][path.basename(filename)];
  const actual = effectContract(edits);
  if (!expected || expected.count !== actual.count || expected.sha256 !== actual.sha256) {
    throw new Error(`Offline effects changed in ${path.basename(filename)}. Review the preview boundary and update its contract.`);
  }
  for (const edit of edits.reverse()) code = code.slice(0, edit.start) + code.slice(edit.end);
  return code;
}
