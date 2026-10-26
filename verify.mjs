import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const file=fileURLToPath(new URL('./neuroslop-mcp.mjs',import.meta.url));
const live=process.argv.includes('--live-check');
assert(process.argv.slice(2).every(arg=>arg==='--live-check'),'Only --live-check is supported');
const env={PATH:process.env.PATH||'/usr/bin:/bin',NEUROSLOP_API_BASE:'https://neuroslop.net'};
const cli=arg=>{
  const r=spawnSync(process.execPath,[file,arg],{encoding:'utf8',env,timeout:5000,maxBuffer:100000});
  assert.equal(r.status,0,arg+' failed');return JSON.parse(r.stdout);
};
const doctor=cli('--doctor');
assert.equal(doctor.server,'neuroslop 1.2.1');assert.equal(doctor.apiKey,'missing');
assert.equal(doctor.neuroslopCheck,'available_keyless');assert.equal(doctor.neuroslopClean,'available_local');
const config=cli('--print-config');
assert.equal(config.claudeDesktop.mcpServers.neuroslop.args[0],file);
assert.equal(config.cursor.mcpServers.neuroslop.command,process.execPath);

const child=spawn(process.execPath,[file],{env,stdio:['pipe','pipe','pipe']});
const pending=new Map();let buffer='',stderr='';
child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
child.stdout.on('data',chunk=>{
  buffer+=chunk.toString();let at;
  while((at=buffer.indexOf('\n'))>=0){
    const line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(!line.trim())continue;
    let value;try{value=JSON.parse(line);}catch{for(const p of pending.values())p.reject(new Error('Non-JSON stdio output'));continue;}
    const p=pending.get(value.id);if(p){pending.delete(value.id);clearTimeout(p.timer);p.resolve(value);}
  }
});
child.on('error',error=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();});
const closed=new Promise(resolve=>child.once('close',resolve));
let id=0;
function rpc(method,params){
  const current=++id;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(current);reject(new Error('Bounded RPC timeout: '+method));},20000);
    pending.set(current,{resolve,reject,timer});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:current,method,params})+'\n');
  });
}
const report={clientVersion:'1.2.1',sha256:createHash('sha256').update(readFileSync(file)).digest('hex'),apiKeyPassed:false,localChecks:[],liveCheck:null,paidRequests:0,automaticRetries:0};
try{
  const initialized=await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'neuroslop-distribution-verifier',version:'1.0.0'}});
  assert.equal(initialized.result.serverInfo.version,'1.2.1');assert.equal(initialized.result.protocolVersion,'2025-11-25');report.localChecks.push('initialize');
  const list=await rpc('tools/list',{});assert.deepEqual(list.result.tools.map(t=>t.name),['neuroslop_check','neuroslop_humanize','neuroslop_clean']);report.localChecks.push('three advertised tools');
  const clean=await rpc('tools/call',{name:'neuroslop_clean',arguments:{text:'A\u200b memo\u00a0for\u202fNora.'}});
  assert.equal(clean.result.structuredContent.text,'A memo for Nora.');assert.equal(clean.result.structuredContent.invisible,3);report.localChecks.push('local Unicode clean');
  const gated=await rpc('tools/call',{name:'neuroslop_humanize',arguments:{text:'This fictional sentence is used only to verify the missing-key gate.'}});
  assert.equal(gated.result.isError,true);assert.equal(gated.result.structuredContent.code,'api_key_required');report.localChecks.push('rewrite refused locally without key');
  if(live){
    const sample='It is important to note that the team will use this checklist to review each draft. Please confirm the dates, names and conditions before publication.';
    const checked=await rpc('tools/call',{name:'neuroslop_check',arguments:{text:sample}});
    assert.notEqual(checked.result?.isError,true,'Free live check failed: '+(checked.result?.structuredContent?.code||'invalid response'));
    const value=checked.result.structuredContent;assert.equal(value.type,'style_analysis');assert.equal(value.aiProbability,null);assert.equal(value.confidenceKind,'not_calibrated');
    report.liveCheck={requests:1,inputRole:'new fictional engineering paragraph, not origin or editorial gold',type:value.type,styleScore:value.styleScore,findingsCount:value.findingsCount,aiProbability:value.aiProbability,confidenceKind:value.confidenceKind,analysisMode:value.analysisMode};
  }
  report.passed=true;
  console.log(JSON.stringify(report,null,2));
}finally{
  for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Verifier closing'));}pending.clear();
  child.stdin.end();const timeout=setTimeout(()=>child.kill('SIGTERM'),2000);await closed;clearTimeout(timeout);
}
