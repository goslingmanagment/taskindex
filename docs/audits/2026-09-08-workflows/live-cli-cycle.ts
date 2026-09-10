import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../../../src/server/db';
import { createAuth } from '../../../src/server/auth';
import { createAgent, createAgentKey } from '../../../src/server/admin';
import { runCli } from '../../../src/cli/run';
const dir = process.env.AUDIT_FIXTURE_DIR!;
if (!dir?.includes('taskindex-e2e-')) throw new Error('Requires isolated fixture directory');
const keyFile=join(dir,'audit-agent.json');
if (!existsSync(keyFile)) {
  const db=openDatabase(join(dir,'workspace.db'));
  const auth=createAuth(db,{baseURL:'http://localhost:4173',secret:'taskindex-isolated-e2e-secret-at-least-32-characters'});
  createAgent(db,{id:'qa-live-cli',label:'QA Агент'});
  const key=await createAgentKey(db,auth,{agentId:'qa-live-cli',scope:'tasks'});
  writeFileSync(keyFile,JSON.stringify(key),{mode:0o600});
  db.close();
}
const key=JSON.parse(readFileSync(keyFile,'utf8')).key;
const results:unknown[]=[];
async function run(args:string[]) {
  const lines:string[]=[];
  const code=await runCli(args,{env:{TASKINDEX_URL:'http://localhost:4173',TASKINDEX_TOKEN:key,XDG_STATE_HOME:join(dir,'cli-state')},stdout:l=>lines.push(l),stderr:l=>lines.push(l)});
  if (lines.join('').includes(key)) throw new Error('Unexpected credential in output');
  results.push({args,code,output:lines.map(l=>{try{return JSON.parse(l)}catch{return l}})});
  if(code!==0)throw new Error(JSON.stringify(results));
}
if(process.argv[2]==='initial') {
  await run(['context']);
  await run(['digest']);
}
await run(['task','sync','--origin',JSON.stringify({system:'audit',ref:'qa-live-source',version:process.argv[2]==='initial'?'1':'2'}),'--fields',JSON.stringify({area:'agency',title:'QA Проверить источник агента',status:'todo',note:process.argv[2]==='initial'?'Источник версия 1':'Источник версия 2'})]);
console.log(JSON.stringify(results,null,2));
