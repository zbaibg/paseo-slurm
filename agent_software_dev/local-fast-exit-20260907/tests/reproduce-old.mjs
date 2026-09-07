// Run the new missing-script regression against the previous CLI, isolated from
// the installed dist and all real Paseo agents/state. Expect timeout/failure.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
const root=mkdtempSync('/scratch/zbai29/paseo-local-old-');
try {
  cpSync('dist',join(root,'dist'),{recursive:true});
  writeFileSync(join(root,'package.json'),' {"type":"module"}\n');
  const old=execFileSync('git',['show','26df381e8222d5c6f9ad31d9935eceab6a72e2c3:src/local-cli.ts'],{encoding:'utf8'});
  const output=ts.transpileModule(old,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
  writeFileSync(join(root,'dist/src/local-cli.js'),output);
  const run=spawnSync(process.execPath,['--test','--test-name-pattern=delivers one terminal callback for missing script','dist/test/local-cli.test.js'],{cwd:root,encoding:'utf8',timeout:15000});
  process.stdout.write(run.stdout||'');process.stderr.write(run.stderr||'');
  if(run.status!==1 || !(run.stdout||'').includes('timed out waiting for detached local task'))throw new Error('Old-code regression did not reproduce as expected');
  console.log('OLD_CODE_RACE_REPRODUCED');
} finally { rmSync(root,{recursive:true,force:true}); }
