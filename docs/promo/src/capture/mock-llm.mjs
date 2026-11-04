// Scripted OpenAI-compatible endpoint for repeatable promo capture.
import http from 'node:http'; import fs from 'node:fs';
const LOG = new URL('./mock.log', import.meta.url).pathname;
const loadScript = () => JSON.parse(fs.readFileSync(new URL('./script.json', import.meta.url)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = o => fs.appendFileSync(LOG, JSON.stringify(o) + '\n');
http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  if (req.url.endsWith('/models')) { res.setHeader('content-type','application/json'); return res.end(JSON.stringify({object:'list',data:[{id:'deepseek-flash',object:'model'}]})); }
  const r = JSON.parse(body || '{}');
  const SCRIPT = loadScript();
  const firstUser = JSON.stringify((r.messages||[]).filter(m=>m.role==='user').at(-1)||'');
  const steps = Object.entries(SCRIPT.scenarios).find(([k])=>JSON.stringify(r.messages).includes(k))?.[1] ?? [{say:'好的。'}];
  const hasTools = (r.tools||[]).length > 0;
  const toolDone = (r.messages||[]).filter(m => m.role === 'tool').length;
  log({url:req.url, hasTools, toolDone, n:(r.messages||[]).length, last:JSON.stringify(r.messages?.at(-1)).slice(0,300), tools:(r.tools||[]).map(t=>t.function?.name)});
  if (toolDone === 0 && hasTools && !fs.existsSync(LOG+'.schema')) fs.writeFileSync(LOG+'.schema', JSON.stringify(r.tools,null,1));
  res.writeHead(200, {'content-type':'text/event-stream','cache-control':'no-cache'});
  const send = delta => res.write('data: '+JSON.stringify({id:'c',object:'chat.completion.chunk',created:0,model:r.model,choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
  const end = reason => { res.write('data: '+JSON.stringify({id:'c',object:'chat.completion.chunk',created:0,model:r.model,choices:[{index:0,delta:{},finish_reason:reason}],usage:{prompt_tokens:1800,completion_tokens:120,total_tokens:1920}})+'\n\n'); res.write('data: [DONE]\n\n'); res.end(); };
  if (!hasTools) { send({role:'assistant',content:SCRIPT.title}); return end('stop'); }
  const step = steps[Math.min(toolDone, steps.length-1)];
  await sleep(step.delay||0);
  send({role:'assistant',content:''});
  const chars = [...(step.say||'')];
  for (let i=0;i<chars.length;i+=2){ send({content:chars.slice(i,i+2).join('')}); await sleep(step.cps||55); }
  if (step.tool) {
    send({tool_calls:[{index:0,id:'call_'+toolDone,type:'function',function:{name:step.tool,arguments:JSON.stringify(step.args)}}]});
    return end('tool_calls');
  }
  end('stop');
}).listen(3399,'127.0.0.1',()=>console.log('mock on 3399'));
