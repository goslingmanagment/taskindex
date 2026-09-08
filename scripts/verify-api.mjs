import assert from 'node:assert/strict';
const base=process.env.SPACE_TEST_URL||'http://localhost:3000';
if(!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base))throw new Error('This test only runs against a local site.');
async function request(action,value,headers={}){const r=await fetch(base+'/api/workspace',{method:action?'POST':'GET',headers:action?{'Content-Type':'application/json',Origin:base,...headers}:headers,body:action?JSON.stringify({action,value}):undefined});let data;const body=await r.text();try{data=JSON.parse(body);}catch{data={error:body};}return {status:r.status,data};}
const state=(await request('initialize')).data;
assert(state.initialized);assert(state.projects.length>=10);assert(state.tasks.length>=19);
const second=(await request('initialize')).data;assert.equal(second.tasks.length,state.tasks.length,'Initialization is idempotent');
const task={id:crypto.randomUUID(),area:'agency',projectId:'hiring',title:'Проверка API: задача',status:'todo',note:'<script>alert(1)</script> — plain text',due:'2026-09-12',waitingFor:'Ответ',followUp:'2026-09-15',checklist:[{id:'c1',text:'Шаг',done:false}],rank:10000,demo:false,archived:false,revision:0};
let r=await request('task',task);assert.equal(r.status,200);assert.equal(r.data.value.revision,1);
assert.equal((await request('task',task)).status,200,'A network retry does not create a duplicate');
let saved=r.data.value;
r=await request('task',{...saved,status:'waiting'});assert.equal(r.status,200);saved=r.data.value;assert.equal(saved.due,'2026-09-12');assert.equal(saved.followUp,'2026-09-15');
const stale=await request('task',{...task,revision:1,title:'stale overwrite'});assert.equal(stale.status,409);assert.equal(stale.data.current.revision,2,'Conflict includes current version for in-editor resolution');
const concurrent=await Promise.all([request('task',{...saved,title:'Вкладка A'}),request('task',{...saved,title:'Вкладка B'})]);assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409],'Only one concurrent edit may win');saved=concurrent.find(r=>r.status===200).data.value;
for(const invalid of [{area:'other'},{projectId:'contentops'},{due:'2026-02-30'},{due:'not-date'},{title:' '},{rank:Infinity},{checklist:[{id:'same',text:'a',done:true},{id:'same',text:'b',done:false}]}]){const result=await request('task',{...saved,...invalid});assert.equal(result.status,400,JSON.stringify(invalid));}
assert.equal((await request('task',saved,{Origin:'https://unrelated.example'})).status,403);
r=await request('task',{...saved,archived:true});assert.equal(r.status,200);saved=r.data.value;
const reloaded=(await request()).data.tasks.find(t=>t.id===saved.id);assert.deepEqual(reloaded,saved,'Read-back preserves task changes and archive state');
const project={id:crypto.randomUUID(),area:'personal',name:'Тест-'+crypto.randomUUID().slice(0,6),color:'#248168',revision:0};
assert.equal((await request('project',project)).status,200);
assert.equal((await request('project',{...project,id:crypto.randomUUID(),name:project.name.toUpperCase()})).status,400,'Russian project names are unique ignoring case');
assert.equal((await request('initialize')).data.tasks.filter(t=>t.id===task.id).length,1,'Initialization does not reset custom data');
console.log('API checks passed: durable read-back, idempotency, concurrent edits, conflict recovery data, area/project boundaries, dates, origin checks, archive, and project names.');
