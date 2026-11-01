import { createServer } from 'node:http'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { RunController } from './run-controller.ts'
import { resolveLocale, uiStrings, type ControlLabels, type Locale } from './locale.ts'


export interface ControlSkillSummary {
  id: string
  state: string
  version: number
  risk: string
  steps: number
  verifiedAt?: string
  scope: string
  evolvedFrom?: string
}

export interface ControlPermissionStatus {
  accessibility?: boolean | null
  screenRecording?: boolean | null
  sessionLocked?: boolean | null
  application?: string
}

export interface ControlServerOptions {
  locale?: Locale
  listSkills?: () => Promise<ControlSkillSummary[]>
  removeSkill?: (id: string) => Promise<boolean>
  permissionStatus?: () => Promise<ControlPermissionStatus>
  openPermission?: (pane: 'accessibility' | 'screenRecording') => Promise<void>
}

interface PageScript {
  labels: ControlLabels
  phases: Record<string, string>
  operations: Record<string, string>
}

function escapeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')
}

function renderHtml(locale: Locale): string {
  const strings = uiStrings(locale)
  const data: PageScript = {
    labels: strings.control,
    phases: strings.phases,
    operations: strings.operations,
  }
  return `<!doctype html><html lang="${locale === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${strings.control.title}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#ffffff;--text:#111827;--muted:#5b6472;--line:#dfe3e9;--accent:#315fd0;--ok:#15803d;--warn:#b45309;--bad:#b91c1c;--chip:#eef2ff}
@media (prefers-color-scheme:dark){:root{--bg:#0f141b;--card:#161d26;--text:#e5e9f0;--muted:#94a3b8;--line:#2a3441;--accent:#7aa2ff;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--chip:#1e2a44}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header{max-width:1080px;margin:0 auto;padding:28px 20px 8px}main{max-width:1080px;margin:0 auto;padding:12px 20px 40px;display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:0 0 12px;letter-spacing:.01em}p{margin:0;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px}.wide{grid-column:1/-1}
.badge{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:999px;padding:3px 9px;font-size:12px;color:var(--muted)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--warn)}.dot.ok{background:var(--ok)}.dot.bad{background:var(--bad)}
button{appearance:none;border:1px solid var(--line);background:var(--card);color:var(--text);border-radius:9px;padding:8px 13px;font:inherit;cursor:pointer}
button:hover{border-color:var(--accent)}button:disabled{opacity:.45;cursor:not-allowed}button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.controls{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.rows{display:grid;gap:8px}.row{display:flex;justify-content:space-between;gap:12px;border-bottom:1px dashed var(--line);padding-bottom:8px}
.row:last-child{border-bottom:0;padding-bottom:0}.key{color:var(--muted)}.value{text-align:right;word-break:break-word}
.state{padding:10px 12px;border-radius:10px;background:var(--chip);font-weight:600}
.token{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}.token input{flex:1;min-width:200px;padding:8px 10px;border:1px solid var(--line);border-radius:9px;background:var(--card);color:var(--text)}
.list{display:grid;gap:10px;margin:0;padding:0;list-style:none}.item{border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.item strong{display:block;font-size:13px}.muted{color:var(--muted);font-size:12px}.timeline{display:grid;gap:8px;margin:0;padding:0;list-style:none;max-height:360px;overflow:auto}
.event{display:grid;grid-template-columns:78px 1fr;gap:10px;padding:7px 0;border-bottom:1px solid var(--line);font-size:12px}.event time{color:var(--muted)}
.permission{display:flex;align-items:center;justify-content:space-between;gap:10px;border-bottom:1px dashed var(--line);padding:8px 0}.permission:last-child{border-bottom:0}
.permission strong{font-size:13px}.error{color:var(--bad);font-size:12px;margin-top:10px}
@media (max-width:640px){header{padding:20px 16px 4px}main{padding:8px 16px 28px;grid-template-columns:1fr}.wide{grid-column:auto}}
</style></head><body>
<header><h1>${data.labels.title}</h1><p>${data.labels.subtitle}</p><div class="token"><input id="token" type="password" autocomplete="off" placeholder="${data.labels.token}"><button id="saveToken">${data.labels.refresh}</button><span id="connection" class="badge"><span class="dot"></span><span>${data.labels.unauthorized}</span></span></div><p class="muted" style="margin-top:8px">${data.labels.tokenHint}</p></header>
<main>
<section class="card" aria-labelledby="statusTitle"><h2 id="statusTitle">${data.labels.statusTitle}</h2><div id="status" class="rows"><p class="muted">${data.labels.none}</p></div><div class="controls"><button id="pause">${data.labels.pause}</button><button id="resume">${data.labels.resume}</button><button id="takeover">${data.labels.takeover}</button><button id="stop" class="primary">${data.labels.stop}</button></div><p id="statusError" class="error" hidden></p></section>
<section class="card" aria-labelledby="permissionsTitle"><h2 id="permissionsTitle">${data.labels.permissionsTitle}</h2><p class="muted">${data.labels.permissionsBody}</p><div id="permissions" class="rows" style="margin-top:10px"></div></section>
<section class="card" aria-labelledby="skillsTitle"><h2 id="skillsTitle">${data.labels.skillsTitle}</h2><ul id="skills" class="list"><li class="muted">${data.labels.skillsEmpty}</li></ul></section>
<section class="card wide" aria-labelledby="auditTitle"><h2 id="auditTitle">${data.labels.auditTitle}</h2><ul id="audit" class="timeline"><li class="muted">${data.labels.auditEmpty}</li></ul><p id="auditError" class="error" hidden></p></section>
</main>
<script>
const L=${escapeJson(data)};
const tokenInput=document.getElementById('token');
const connection=document.getElementById('connection');
let token=sessionStorage.getItem('dsh-cu-token')||'';
const hash=new URLSearchParams(location.hash.slice(1));
const query=new URLSearchParams(location.search);
const supplied=hash.get('token')||query.get('token');
if(supplied){token=supplied;sessionStorage.setItem('dsh-cu-token',token);history.replaceState(null,'',location.pathname)}
// The page token is a one-time view credential from the URL fragment; if the API
// rejects it, fall back to the credential the user pasted.
if(!token)history.replaceState(null,'',location.pathname+location.search)
tokenInput.value=token;
function esc(value){return value===undefined||value===null?'':String(value)}
function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node}
function row(key,value){const div=el('div','row');div.append(el('span','key',key),el('span','value',esc(value)));return div}
function setConnection(ok,text){connection.querySelector('.dot').className='dot '+(ok?'ok':'bad');connection.lastElementChild.textContent=text}
async function api(path,method,body){const headers={authorization:'Bearer '+token};if(body!==undefined)headers['content-type']='application/json';const response=await fetch(path,{method:method||'GET',headers,body:body===undefined?undefined:JSON.stringify(body)});if(!response.ok){const text=await response.text();const error=new Error(text||response.statusText);error.status=response.status;throw error}return response.json()}
function elapsedText(record){const end=record.finishedAt?Date.parse(record.finishedAt):Date.now();const start=Date.parse(record.startedAt);if(!Number.isFinite(start)||!Number.isFinite(end))return '';return Math.max(0,Math.round((end-start)/1000))+'s'}
function renderStatus(state){
  const box=document.getElementById('status');box.replaceChildren();
  if(!state.active&&!state.last){box.append(el('p','muted',L.labels.none));return}
  const record=state.active||state.last;const label=state.active?L.labels.active:L.labels.last;
  box.append(row(L.labels.status,label+' · '+(state.active&&record.status==='paused'?L.phases.paused:record.status)));
  if(record.kind)box.append(row(L.labels.route,record.route||record.kind));
  if(record.reason)box.append(row(L.labels.reason,record.reason));
  if(record.startedAt)box.append(row(L.labels.elapsed,elapsedText(record)));
}
function renderPermissions(value){
  const box=document.getElementById('permissions');box.replaceChildren();
  if(!value||value.available===false){box.append(el('p','muted',L.labels.unknown));return}
  const rows=[['accessibility',L.labels.accessibility],['screenRecording',L.labels.screenRecording]];
  for(const entry of rows){
    const key=entry[0];const status=value[key];const wrap=el('div','permission');
    const text=el('div');text.append(el('strong',null,entry[1]),el('div','muted',status===true?L.labels.granted:status===false?L.labels.notGranted:L.labels.unknown));
    const actions=el('div','controls');actions.style.marginTop='0';
    const settings=el('button',null,status===true?L.labels.openSettings:L.labels.requestPermission);settings.addEventListener('click',()=>openPermission(key));actions.append(settings);
    wrap.append(text,actions);box.append(wrap);
  }
  if(value.application)box.append(row(L.labels.permissionsTitle,value.application));
}
async function openPermission(pane){try{await api('/api/open-permission','POST',{pane});await refreshPermissions()}catch(error){showError('statusError',error.message)}}
function renderSkills(skills){
  const box=document.getElementById('skills');box.replaceChildren();
  if(!skills.length){box.append(el('li','muted',L.labels.skillsEmpty));return}
  for(const skill of skills){const item=el('li','item');item.append(el('strong',null,skill.id+' · v'+skill.version+' · '+skill.state));
    item.append(el('div','muted',L.labels.skillScope+': '+esc(skill.scope)));
    item.append(el('div','muted',L.labels.skillRisk+': '+esc(skill.risk)+' · '+L.labels.skillSteps+': '+esc(skill.steps)));
    if(skill.verifiedAt)item.append(el('div','muted',L.labels.skillVerified+': '+esc(skill.verifiedAt)));
    const remove=el('button',null,L.labels.deleteSkill);remove.addEventListener('click',()=>removeSkill(skill.id));item.append(remove);
    box.append(item)}
}
async function removeSkill(id){
  if(!confirm(L.labels.deleteSkill+' '+id))return;
  try{await api('/api/skills/remove','POST',{id});await refresh()}catch(error){showError('statusError',error.message)}
}
function renderAudit(events){
  const box=document.getElementById('audit');box.replaceChildren();
  if(!events.length){box.append(el('li','muted',L.labels.auditEmpty));return}
  for(const event of events){const item=el('li','event');item.append(el('time',null,new Date(event.at).toLocaleTimeString()));const body=el('div');body.append(el('div',null,event.kind));if(event.detail)body.append(el('div','muted',JSON.stringify(event.detail)));item.append(body);box.append(item)}
}
function showError(id,message){const node=document.getElementById(id);node.textContent=message;node.hidden=false}
function clearError(id){const node=document.getElementById(id);node.hidden=true}
async function refreshPermissions(){
  if(!token)return;
  try{renderPermissions(await api('/api/permissions'))}catch(error){const box=document.getElementById('permissions');box.replaceChildren(el('p','error',error.message))}
}
async function refresh(){
  if(!token){setConnection(false,L.labels.unauthorized);return}
  try{
    const [status,skills,audit]=await Promise.all([api('/api/status'),api('/api/skills'),api('/api/audit')]);
    setConnection(true,L.labels.connected);renderStatus(status);renderSkills(skills.skills||[]);renderAudit(audit.events||[]);clearError('statusError');clearError('auditError');
  }catch(error){setConnection(false,error.status===401?L.labels.unauthorized:L.labels.loadFailed);if(error.status!==401)showError('statusError',error.message)}
}
async function control(action){try{await api('/api/'+action,'POST');await refresh()}catch(error){showError('statusError',error.message)}}
for(const action of ['pause','resume','stop','takeover'])document.getElementById(action).addEventListener('click',()=>control(action));
document.getElementById('saveToken').addEventListener('click',()=>{token=tokenInput.value;sessionStorage.setItem('dsh-cu-token',token);refresh()});
setInterval(refresh,1000);refresh();refreshPermissions();
</script></body></html>`
}

/** Raised for a body over the limit so the caller can answer 413 instead of resetting the socket (CR-07). */
export class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super('request body too large')
    this.name = 'BodyTooLargeError'
  }
}

function bodyJson(request: IncomingMessage, limit = 8192): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    let settled = false
    const chunks: Buffer[] = []
    const finish = (error: unknown, value?: Record<string, unknown>): void => {
      if (settled) return
      settled = true
      if (error === undefined) resolve(value ?? {})
      else reject(error)
    }
    request.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        // Keep draining so the peer receives the 413 response instead of an
        // ECONNRESET; the buffered chunks are dropped.
        chunks.length = 0
        finish(new BodyTooLargeError(limit))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (chunks.length === 0) return finish(undefined, {})
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        finish(undefined, value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})
      } catch (error) {
        finish(error)
      }
    })
    request.on('error', error => finish(error))
  })
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * True when the `Host` header names a loopback authority. A DNS-rebinding
 * request carries the attacker's own host name, so a mismatch is refused
 * outright (CR-07).
 */
export function isLoopbackHost(header: string | undefined): boolean {
  if (header === undefined || header === '') return true
  let hostname: string
  try {
    hostname = new URL(`http://${header}`).hostname.toLowerCase()
  } catch {
    return false
  }
  return LOOPBACK_HOSTS.has(hostname)
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

/** Constant-time comparison of two bearer values. */
export function safeTokenEqual(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false
  return timingSafeEqual(digest(actual), digest(expected))
}

export class ControlServer {
  /** Per-server page credential; the configured control token never enters a tool result URL. */
  readonly pageToken = randomUUID()
  /** Page-token lifetime; the panel re-reads the fragment or falls back to the configured token (CR-07). */
  readonly pageTokenTtlMs = 30 * 60 * 1000
  /** Clock used for the page-token TTL, injectable for tests. */
  now: () => number = Date.now
  private readonly pageTokenIssuedAt = Date.now()
  private server?: Server
  private url?: string
  private readonly locale: Locale

  constructor(
    private readonly controller: RunController,
    private readonly agent: Agent,
    private readonly token: string,
    private readonly options: ControlServerOptions = {},
  ) {
    this.locale = resolveLocale(options.locale)
  }

  async start(port = 0): Promise<string> {
    if (this.url !== undefined) return this.url
    const html = renderHtml(this.locale)
    this.server = createServer(async (request, response) => {
      try {
        if (!isLoopbackHost(request.headers.host)) {
          this.json(response, 403, { error: 'host_not_allowed' })
          return
        }
        // The credential-entry shell is public by design: it is the only way a
        // user can paste a token, so it must load before any credential exists.
        // It carries no token, no run state and no Skill data - only the locale
        // strings that a `GET /api/*` call would otherwise require.
        if ((request.url === '/' || request.url?.startsWith('/?')) && request.method === 'GET') {
          response.writeHead(200, {
            'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
            'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
          })
          response.end(html)
          return
        }
        if (request.url === '/favicon.ico') {
          response.writeHead(204, { 'cache-control': 'no-store' }).end()
          return
        }
        if (!this.authorized(request)) {
          response.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end()
          return
        }
        if (request.url === '/api/status' && request.method === 'GET') {
          this.json(response, 200, this.controller.status(this.agent))
          return
        }
        if (request.url === '/api/audit' && request.method === 'GET') {
          this.json(response, 200, { events: await this.controller.auditEvents() })
          return
        }
        if (request.url === '/api/skills' && request.method === 'GET') {
          this.json(response, 200, { skills: this.options.listSkills === undefined ? [] : await this.options.listSkills() })
          return
        }
        if (request.url === '/api/permissions' && request.method === 'GET') {
          const status = this.options.permissionStatus === undefined ? { available: false } : await this.options.permissionStatus()
          this.json(response, 200, { available: this.options.permissionStatus !== undefined, ...status })
          return
        }
        if (request.url === '/api/open-permission' && request.method === 'POST') {
          if (this.options.openPermission === undefined) {
            this.json(response, 503, { error: 'permission_actions_unavailable' })
            return
          }
          const body = await bodyJson(request)
          const pane = body.pane
          if (pane !== 'accessibility' && pane !== 'screenRecording') {
            this.json(response, 400, { error: 'invalid_permission_pane' })
            return
          }
          await this.options.openPermission(pane)
          this.json(response, 200, { ok: true })
          return
        }
        if (request.url === '/api/skills/remove' && request.method === 'POST') {
          if (this.options.removeSkill === undefined) {
            this.json(response, 503, { error: 'skill_removal_unavailable' })
            return
          }
          const body = await bodyJson(request)
          if (typeof body.id !== 'string' || body.id.length === 0) {
            this.json(response, 400, { error: 'invalid_skill_id' })
            return
          }
          const removed = await this.options.removeSkill(body.id)
          // Privilege changes are audited, and the Skill id itself never is (CR-07).
          this.controller.recordControlEvent({
            agentId: this.agent.id,
            kind: 'skill_removed',
            detail: { action: 'remove_skill', status: removed ? 'removed' : 'absent' },
          })
          this.json(response, 200, { removed })
          return
        }
        const actions: Record<string, () => void> = {
          '/api/pause': () => this.controller.pause(this.agent),
          '/api/resume': () => this.controller.resume(this.agent),
          '/api/stop': () => this.controller.stop(this.agent),
          '/api/takeover': () => this.controller.takeover(this.agent),
        }
        const action = request.url ? actions[request.url] : undefined
        if (action !== undefined && request.method === 'POST') {
          action()
          this.json(response, 200, this.controller.status(this.agent))
          return
        }
        this.json(response, 404, { error: 'not_found' })
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          this.json(response, 413, { error: 'payload_too_large' })
          return
        }
        // The body is a stable code; the detail stays on the server log (CR-07).
        console.error('dsh-cu control request failed', request.method,
          error instanceof Error ? `${error.name}: ${error.message}` : 'Error')
        this.json(response, 500, { error: 'internal_error' })
      }
    })
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(port, '127.0.0.1', () => resolve())
    })
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('Control server has no address')
    this.url = `http://127.0.0.1:${address.port}`
    return this.url
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    const body = JSON.stringify(value)
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(body)
  }

  /**
   * `/` returns a credential-entry shell and never data; everything under
   * `/api/*` requires a bearer. `/` also drops any token from the address bar,
   * so a `#token=` fragment is a one-time view credential, not a stored one.
   */
  /** True when the bearer is the configured token, or an unexpired page token. */
  private authorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization
    if (safeTokenEqual(header, `Bearer ${this.token}`)) return true
    if (this.now() - this.pageTokenIssuedAt > this.pageTokenTtlMs) return false
    return safeTokenEqual(header, `Bearer ${this.pageToken}`)
  }

  async close(): Promise<void> {
    if (this.server === undefined) return
    await new Promise<void>((resolve, reject) => this.server!.close(error => error ? reject(error) : resolve()))
    this.server = undefined
  }
}
