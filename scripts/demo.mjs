import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const project = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(project, 'bin/dt.js');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dt-demo-'));
const output = path.join(project, 'artifacts', 'demo');
await fs.mkdir(output, { recursive: true });
const markup = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>DT · 浏览器操作演示</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f4f6fa;color:#172437;font:16px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
main{max-width:980px;margin:64px auto;padding:0 28px}.eyebrow{font-size:12px;letter-spacing:3px;color:#4c647d;font-weight:600}
h1{font-size:38px;letter-spacing:-1px;margin:12px 0}header p{color:#617084;margin:0 0 32px}.grid{display:grid;grid-template-columns:1.1fr 1fr;gap:24px}
section{background:white;border:1px solid #dce2ea;border-radius:16px;padding:28px;box-shadow:0 8px 30px #182d4b05}h2{font-size:19px;margin:0 0 22px}
label{display:block;color:#4b5b70;font-size:14px;margin:18px 0 8px}input,select{font:inherit;width:100%;padding:12px;border:1px solid #cbd4df;border-radius:8px;background:white;color:#172437}
button{margin-top:26px;background:#265add;color:white;border:0;border-radius:8px;padding:13px 22px;font:600 15px/1.5 inherit;cursor:pointer;width:100%}
.empty{color:#8b98a8;margin-top:54px;text-align:center}.saved{background:#eaf7ef;border:1px solid #bfdfcc;border-radius:10px;padding:20px;margin-top:20px}.saved strong{display:block;color:#1e6542;font-size:21px}.saved p{color:#426352;margin-bottom:0}
footer{font-size:12px;color:#8390a2;margin-top:24px}.pill{display:inline-block;font-size:12px;padding:4px 9px;color:#2d6e4b;background:#e9f4ed;border-radius:99px}
</style><main><header><div class="eyebrow">BROWSER AGENT CLI</div><h1>从观察页面，到完成操作。</h1><p>本地表单演示 · 由 dt 命令读取、填写并验证</p></header>
<div class="grid"><section><h2>创建演示任务</h2><form><label for="task-name">任务名称</label><input id="task-name" name="name" placeholder="输入任务名称" required>
<label for="category">任务类型</label><select id="category" name="category"><option value="observe">页面观察</option><option value="automation">自动化验证</option></select><button type="submit">保存任务</button></form></section>
<section><h2>保存结果 <span class="pill">本机服务</span></h2><div id="result" aria-live="polite"><p class="empty">等待提交表单</p></div></section></div>
<footer>此页面仅在 127.0.0.1 上提供 · 所有数据均为演示数据</footer></main><script>
document.querySelector('form').addEventListener('submit',async(event)=>{event.preventDefault();const values=Object.fromEntries(new FormData(event.target));const response=await fetch('/api/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(values)});const data=await response.json();const result=document.getElementById('result');result.replaceChildren();const card=document.createElement('div');card.className='saved';const title=document.createElement('strong');title.textContent='已保存 · '+data.name;const description=document.createElement('p');description.textContent='类型：自动化验证 · HTTP 201';card.append(title,description);result.append(card);});
</script></html>`;
const server = http.createServer(async (req, res) => {
  if (req.url === '/api/tasks' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.stringify({ id: 1, ...JSON.parse(body), saved: true });
    res.writeHead(201, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  } else { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(markup); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const probe = net.createServer();
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const env = { ...process.env, DT_STATE_DIR: path.join(temporary, 'state'), DT_PROFILE: path.join(temporary, 'profile'),
  DT_PORT: String(port), DT_SESSION: 'live-demo', DT_TASK: 'form', DT_IDLE_TIMEOUT_MS: '900000' };
const history = [];
async function dt(...args) {
  process.stdout.write('\n> dt ' + args.map((arg) => JSON.stringify(arg)).join(' ') + ' --json\n');
  const { stdout } = await exec(process.execPath, [cli, ...args, '--json'], { env, timeout: 30_000, maxBuffer: 4_000_000 });
  const result = JSON.parse(stdout);
  history.push({ command: args, result });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result;
}
let launched = false, closing = false, timer;
async function cleanup() {
  if (closing) return;
  closing = true;
  clearTimeout(timer);
  if (launched) await dt('kill', '--daemon', '--browser').catch(() => {});
  server.close();
}
process.on('SIGTERM', () => { void cleanup(); });
process.on('SIGINT', () => { void cleanup(); });
try {
  await dt('launch');
  launched = true;
  await dt('goto', `http://127.0.0.1:${server.address().port}`);
  const snapshot = await dt('snapshot');
  const name = snapshot.elements.find((element) => element.role === 'textbox' && element.name === '任务名称');
  const category = snapshot.elements.find((element) => element.role === 'combobox');
  const save = snapshot.elements.find((element) => element.role === 'button' && element.name === '保存任务');
  if (!name?.ref || !category?.ref || !save?.ref) throw new Error('demo controls missing from snapshot');
  await dt('fill', name.ref, '我的第一个浏览器任务');
  await new Promise((resolve) => setTimeout(resolve, 700));
  await dt('select', category.ref, 'automation');
  await dt('reqclear');
  await new Promise((resolve) => setTimeout(resolve, 700));
  await dt('click', save.ref);
  await dt('wait', 'text=已保存');
  const requests = await dt('reqs', 'method:POST');
  const request = requests.requests.find((item) => item.url.endsWith('/api/tasks'));
  if (!request) throw new Error('demo POST request not captured');
  await dt('req', String(request.n));
  await dt('res', String(request.n));
  await dt('snapshot');
  await dt('shot', path.join(output, 'completed.png'));
  await dt('har', path.join(output, 'capture.har'));
  await fs.writeFile(path.join(output, 'transcript.json'), JSON.stringify(history, null, 2));
  await fs.writeFile(path.join(output, 'session.json'), JSON.stringify({ stateDir: env.DT_STATE_DIR, profileDir: env.DT_PROFILE, port, demoPid: process.pid }, null, 2));
  process.stdout.write('\n演示完成。页面保留 10 分钟后自动关闭。截图和调用记录：' + output + '\n');
  timer = setTimeout(() => { void cleanup(); }, 600_000);
} catch (error) {
  process.stderr.write(error.stack + '\n');
  await cleanup();
  process.exitCode = 1;
}
