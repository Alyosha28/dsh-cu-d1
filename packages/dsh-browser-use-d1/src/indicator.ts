import { randomUUID } from 'node:crypto'
import type { CDPSession, Page } from 'playwright'
import { z } from 'zod'
import type { ActivityEvent, ActivitySink, ControlAction } from '@dsh-cu/core/activity'
import { uiStrings, type PanelStrings } from '@dsh-cu/core/locale'
import type { RunStatus } from '@dsh-cu/core/contract'
import { TabMarker } from './tab-marker.ts'

const controlEvent = z.object({
  runId: z.string().uuid(),
  action: z.enum(['pause', 'resume', 'stop', 'takeover', 'dismiss']),
}).strict()

interface IndicatorEvent {
  type: 'start' | 'activity' | 'finish'
  runId: string
  activity?: ActivityEvent
}

export interface RunOutcome {
  status: RunStatus | 'failed'
  reason: string
  route?: 'skill' | 'd1' | 'human'
}

export type { PanelStrings }
export const DEFAULT_PANEL_STRINGS: PanelStrings = uiStrings('zh')

function indicatorSource(hostId: string, eventName: string, bindingName: string, showPanel: boolean, strings: PanelStrings): string {
  return `(() => {
    const hostId = ${JSON.stringify(hostId)};
    const eventName = ${JSON.stringify(eventName)};
    const bindingName = ${JSON.stringify(bindingName)};
    const showPanel = ${JSON.stringify(showPanel)};
    const L = ${JSON.stringify(strings)};
    let host;
    let shadow;
    let cursor;
    let status;
    let pauseButton;
    let resumeButton;
    let activeRun;
    const install = () => {
      if (!document.documentElement || activeRun === undefined) return;
      if (document.getElementById(hostId)) return;
      host = document.createElement('div');
      host.id = hostId;
      host.setAttribute('data-dsh-cu-control', '');
      host.setAttribute('data-dsh-cu-phase', 'running');
      host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;margin:0;padding:0;border:0;';
      shadow = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = \`
        * { box-sizing: border-box; }
        .panel { position: fixed; right: 16px; bottom: 16px; width: 288px; padding: 12px;
          border: 1px solid rgba(255,255,255,.25); border-radius: 12px; color: #f8fafc;
          background: rgba(15,23,42,.94); box-shadow: 0 8px 30px rgba(0,0,0,.25);
          font: 13px -apple-system, BlinkMacSystemFont, sans-serif; pointer-events: auto; }
        .heading { display: flex; align-items: center; gap: 7px; font-weight: 650; }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: #34d399;
          box-shadow: 0 0 0 4px rgba(52,211,153,.15); }
        .status { margin-top: 7px; color: #cbd5e1; min-height: 18px; }
        .controls { display: flex; gap: 7px; margin-top: 10px; }
        button { appearance: none; border: 1px solid #475569; border-radius: 7px; padding: 5px 10px;
          color: #f8fafc; background: #1e293b; font: 12px -apple-system, BlinkMacSystemFont, sans-serif;
          cursor: pointer; }
        button:hover { background: #334155; }
        button.stop { border-color: #b45309; }
        button[hidden] { display: none; }
        .cursor { position: fixed; left: 0; top: 0; width: 52px; height: 52px; display: none;
          pointer-events: none; filter: drop-shadow(0 2px 2px rgba(2,12,24,.28));
          transition: transform 120ms cubic-bezier(.16,1,.3,1); }
        .pulse { position: fixed; width: 30px; height: 30px; margin: -15px; border: 1.6px solid #315fd0;
          border-radius: 50%; pointer-events: none; animation: pulse .4s cubic-bezier(.16,1,.3,1) forwards; }
        @keyframes pulse { from { opacity: .85; transform: scale(.55); } to { opacity: 0; transform: scale(1.35); } }
      \`;
      shadow.appendChild(style);
      const panel = document.createElement('div');
      panel.className = 'panel';
      panel.style.display = showPanel ? 'block' : 'none';
      panel.setAttribute('role', 'region');
      panel.setAttribute('aria-label', L.panel.controllingBrowser);
      const heading = document.createElement('div');
      heading.className = 'heading';
      const dot = document.createElement('span');
      dot.className = 'dot';
      const title = document.createElement('span');
      title.textContent = L.panel.controllingBrowser;
      heading.append(dot, title);
      status = document.createElement('div');
      status.className = 'status';
      status.textContent = L.panel.preparing;
      const controls = document.createElement('div');
      controls.className = 'controls';
      const makeButton = (action, label, extraClass) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.className = extraClass || '';
        button.setAttribute('data-dsh-action', action);
        button.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          if (activeRun !== undefined) window[bindingName](JSON.stringify({ runId: activeRun, action }));
        });
        controls.appendChild(button);
        return button;
      };
      pauseButton = makeButton('pause', L.panel.pause);
      resumeButton = makeButton('resume', L.panel.resume);
      resumeButton.hidden = true;
      makeButton('stop', L.panel.stop, 'stop');
      makeButton('takeover', L.panel.takeoverAction);
      panel.append(heading, status, controls);
      cursor = document.createElement('div');
      cursor.className = 'cursor';
      cursor.innerHTML = '<svg viewBox="-4 -4 52 52" aria-hidden="true"><path d="M6 5 L32 27 L22 28 L16 39 Z" fill="#315fd0" stroke="#173b82" stroke-width="1.35" stroke-linejoin="round"/><path d="M10 11 L27 25 L21 26" fill="none" stroke="#ffffff" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="5" r="7" fill="#ffffff" fill-opacity=".88" stroke="#315fd0" stroke-width="1.2"/><circle cx="6" cy="5" r="2.2" fill="#315fd0"/></svg>';
      shadow.append(panel, cursor);
      document.documentElement.appendChild(host);
    };
    const finish = () => {
      activeRun = undefined;
      document.getElementById(hostId)?.remove();
      host = undefined;
      shadow = undefined;
      cursor = undefined;
      status = undefined;
      pauseButton = undefined;
      resumeButton = undefined;
    };
    document.addEventListener(eventName, raw => {
      const event = JSON.parse(raw.detail);
      if (event.type === 'start') {
        activeRun = event.runId;
        install();
        return;
      }
      if (event.type === 'activity' && activeRun === undefined) activeRun = event.runId;
      if (event.runId !== activeRun) return;
      if (event.type === 'finish') {
        finish();
        return;
      }
      if (event.type !== 'activity') return;
      install();
      if (!host || !status || !cursor) return;
      const activity = event.activity;
      const operation = L.operations[activity.operation] || activity.operation || '';
      const step = activity.step && activity.maxSteps ? ' · ' + L.panel.step + ' ' + activity.step + '/' + activity.maxSteps : '';
      const base = L.phases[activity.phase] || L.panel.preparing;
      status.textContent = activity.phase === 'acting' && operation ? base + ' · ' + operation + step : base + step;
      host.setAttribute('data-dsh-cu-phase', activity.phase);
      host.setAttribute('data-dsh-cu-operation', activity.operation || '');
      if (pauseButton && resumeButton) {
        pauseButton.hidden = activity.phase === 'paused';
        resumeButton.hidden = activity.phase !== 'paused';
      }
      if (activity.point) {
        const x = Math.max(0, Math.min(innerWidth - 2, activity.point.x));
        const y = Math.max(0, Math.min(innerHeight - 2, activity.point.y));
        cursor.style.display = 'block';
        cursor.style.transform = 'translate(' + (x - 10) + 'px,' + (y - 9) + 'px)';
        host.setAttribute('data-dsh-cu-point', Math.round(x) + ',' + Math.round(y));
        if (activity.phase === 'acting' && activity.operation === 'CLICK' && shadow) {
          const pulse = document.createElement('div');
          pulse.className = 'pulse';
          pulse.style.left = x + 'px';
          pulse.style.top = y + 'px';
          shadow.appendChild(pulse);
          setTimeout(() => pulse.remove(), 450);
        }
      }
    });
  })()`
}

export interface BrowserRunIndicator extends ActivitySink {
  start(runId: string): Promise<void>
  finish(outcome?: RunOutcome): Promise<void>
  dismiss(): Promise<void>
  close(): Promise<void>
}

export class BrowserControlIndicator implements BrowserRunIndicator {
  private readonly hostId = `dsh-cu-${randomUUID()}`
  private readonly eventName = `dsh-cu-activity-${randomUUID()}`
  private readonly bindingName = `dshCuControl${randomUUID().replaceAll('-', '')}`
  private readonly worldName = `dsh-cu-control-${randomUUID()}`
  private cdp?: CDPSession
  private runId?: string
  private scriptInstalled = false
  private readonly marker: TabMarker

  constructor(
    private readonly page: Page,
    private readonly onControl: (action: ControlAction) => void,
    private readonly showPanel = true,
    private readonly strings: PanelStrings = DEFAULT_PANEL_STRINGS,
  ) {
    this.marker = new TabMarker(page, strings.panel.tabMark)
  }

  private readonly bindingCalled = (event: { name: string; payload: string }): void => {
    if (event.name !== this.bindingName) return
    const control = controlEvent.safeParse(JSON.parse(event.payload))
    if (!control.success || control.data.runId !== this.runId) return
    this.onControl(control.data.action)
  }

  private async install(): Promise<void> {
    if (this.cdp === undefined) {
      this.cdp = await this.page.context().newCDPSession(this.page)
      await this.cdp.send('Page.enable')
      await this.cdp.send('Runtime.enable')
      await this.cdp.send('Runtime.addBinding', {
        name: this.bindingName,
        executionContextName: this.worldName,
      })
      this.cdp.on('Runtime.bindingCalled', this.bindingCalled)
    }
    const source = indicatorSource(this.hostId, this.eventName, this.bindingName, this.showPanel, this.strings)
    if (!this.scriptInstalled) {
      await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source,
        worldName: this.worldName,
      })
      this.scriptInstalled = true
    }
    const { frameTree } = await this.cdp.send('Page.getFrameTree')
    const { executionContextId } = await this.cdp.send('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id,
      worldName: this.worldName,
      grantUniveralAccess: false,
    })
    const result = await this.cdp.send('Runtime.evaluate', {
      expression: source,
      contextId: executionContextId,
      returnByValue: true,
    })
    if (result.exceptionDetails !== undefined) throw new Error('browser_indicator_bootstrap_failed')
  }

  private async send(event: IndicatorEvent): Promise<void> {
    await this.page.evaluate(({ eventName, serialized }) => {
      document.dispatchEvent(new CustomEvent(eventName, { detail: serialized }))
    }, { eventName: this.eventName, serialized: JSON.stringify(event) })
  }

  async start(runId: string): Promise<void> {
    z.string().uuid().parse(runId)
    this.runId = runId
    try {
      await this.install()
      await this.send({ type: 'start', runId })
      await this.marker.start()
      await this.activity({ phase: 'running' })
    } catch (error) {
      this.runId = undefined
      throw error
    }
  }

  async activity(event: ActivityEvent): Promise<void> {
    if (this.runId === undefined) throw new Error('browser_indicator_not_running')
    await this.send({ type: 'activity', runId: this.runId, activity: event })
  }

  async finish(_outcome?: RunOutcome): Promise<void> {
    const runId = this.runId
    this.runId = undefined
    if (runId === undefined || this.page.isClosed()) return
    await Promise.allSettled([
      this.send({ type: 'finish', runId }),
      this.page.evaluate(hostId => document.getElementById(hostId)?.remove(), this.hostId),
      this.marker.clear(),
    ])
  }

  async dismiss(): Promise<void> {
    await this.finish()
  }

  async close(): Promise<void> {
    await this.finish()
    const cdp = this.cdp
    this.cdp = undefined
    if (cdp !== undefined) {
      cdp.off('Runtime.bindingCalled', this.bindingCalled)
      await cdp.detach().catch(() => undefined)
    }
  }
}
