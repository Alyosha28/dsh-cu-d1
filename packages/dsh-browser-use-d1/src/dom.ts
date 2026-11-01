import type { ElementHandle, Page } from 'playwright'
import type { Decision } from './decision.ts'


import type { ObservedElement, Observation } from '@albaincompleta/dsh-cu-core/types'
import type { ActivitySink } from '@albaincompleta/dsh-cu-core/activity'
import type { Verification } from '@albaincompleta/dsh-cu-core/contract'
import { isSensitiveInput } from '@albaincompleta/dsh-cu-core/policy'

export type { ObservedElement, Observation } from '@albaincompleta/dsh-cu-core/types'
export { verificationSchema } from '@albaincompleta/dsh-cu-core/contract'

/**
 * Snapshot integrity (BR-01 / BR-14).
 *
 * The invariant this file protects: *the element that receives input is the
 * element the agent observed and was approved on*. It is enforced with three
 * independent layers, because no single one is enough against a hostile page.
 *
 * 1. Provider-side version. `snapshot()` records the page's mutation counter in
 *    Node memory; `assertFresh()` requires the page counter to still be equal.
 *    Any child, attribute, style or form change therefore invalidates the
 *    snapshot. (The counter itself lives in a page global, so a page that
 *    replaces it can be made to *look* idle — this layer raises the cost of an
 *    attack, it is not a proof.)
 *
 * 2. Node identity. Each element the agent may act on is bound to a live
 *    `ElementHandle` taken with `evaluateHandle` at snapshot time. Dispatch uses
 *    that handle, never a re-resolved CSS selector, so a page that copies
 *    `data-dsh-decision-id` onto a trap cannot redirect the click: the handle
 *    still points at the original node.
 *
 * 3. Token + uniqueness. Every observed element is re-stamped with
 *    `data-dsh-decision-id="eN"` and `data-dsh-decision-token="<snapshot>-eN"`,
 *    after clearing every previous id/token (BR-14). Freshness re-checks that
 *    (a) the stage attribute still names this snapshot and version, (b) exactly
 *    one element carries the id, (c) it is the same node as the handle, (d) its
 *    token equals `<snapshot>-<id>`, and (e) it is connected and actionable.
 *
 * Residual assumption (deliberate, not claimed otherwise): the page owns its
 * own DOM and its own globals, so layers 1 and 3 are *signatures*, not secrets.
 * Only layer 2 — holding the node — is authoritative. A page that mutates the
 * document between the freshness check and the dispatch is still caught,
 * because `handle.click()` acts on the retained node (or fails).
 */

const INSTALL_OBSERVER_SCRIPT = `(() => {
  const STATE = '__dshDecisionState';
  const existing = window[STATE];
  const state = existing && typeof existing === 'object' ? existing : { version: 0 };
  window[STATE] = state;
  const bump = () => { state.version += 1; };
  // One observer per document, keyed by a bootstrap id: re-arming must not stack
  // observers (that would double-count every mutation and make staleness noisy).
  if (typeof state.bootstrapId === 'string' && state.bootstrapId !== '') {
    state.bump = bump;
    if (!state.armed) {
      state.armed = true;
      new MutationObserver(record => { state.bump(); void record; }).observe(document.documentElement, {
        subtree: true, childList: true, characterData: true,
        attributes: true,
        attributeFilter: [
          'data-dsh-decision-id', 'data-dsh-decision-token', 'style', 'class', 'hidden',
          'disabled', 'aria-disabled', 'aria-hidden', 'tabindex'
        ]
      });
      document.addEventListener('input', () => state.bump(), true);
      document.addEventListener('change', () => state.bump(), true);
    }
    return typeof state.version === 'number';
  }
  state.bootstrapId = String(Date.now()) + ':' + String(Math.random());
  state.version = 0;
  state.armed = true;
  state.bump = bump;
  new MutationObserver(bump).observe(document.documentElement, {
    subtree: true, childList: true, characterData: true,
    attributes: true,
    attributeFilter: [
      'data-dsh-decision-id', 'data-dsh-decision-token', 'style', 'class', 'hidden',
      'disabled', 'aria-disabled', 'aria-hidden', 'tabindex'
    ]
  });
  document.addEventListener('input', bump, true);
  document.addEventListener('change', bump, true);
  return true;
})()`

const SNAPSHOT_SCRIPT = `({snapshotId, maxElements}) => {
  /**
   * Provider-owned sensitive-field classifier, mirrored from
   * @albaincompleta/dsh-cu-core/policy (isSensitiveInput). It is inlined because
   * a page.evaluate argument cannot close over module scope, and a hidden test
   * cross-checks that the two stay in agreement.
   */
  const SENSITIVE_AUTOCOMPLETE = ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-name'];
  // Word boundaries are written without a backslash: the closing backtick of
  // this outer template would otherwise eat it and break the whole script.
  const SENSITIVE_PATTERN = /pin|passcode|otp|one[-_ ]?time|cvv|cvc|security code|card number|credit card|debit card|(^|[^a-z0-9])ban([^a-z0-9]|$)|seed phrase|mnemonic|recovery code|验证码|密码|口令|卡号|安全码|动态码|校验码/i;
  const isSensitiveInput = (element) => {
    if (element === undefined || element === null) return false;
    const inputType = (element.inputType || '').toLowerCase();
    if (inputType === 'password') return true;
    const raw = [element.context || '', element.identifier || '', inputType].join(' ') + ' ' + (element.autocomplete || '');
    for (const match of raw.matchAll(/autocomplete\s*=\s*["']?([^"'\s;]+)/gi)) {
      if (SENSITIVE_AUTOCOMPLETE.includes(match[1].toLowerCase())) return true;
    }
    if (element.autocomplete && SENSITIVE_AUTOCOMPLETE.includes(String(element.autocomplete).toLowerCase().split(' ')[0])) return true;
    const haystack = [element.name || '', element.identifier || '', element.context || '', inputType].join(' ');
    return SENSITIVE_PATTERN.test(haystack.toLowerCase());
  };
  const interactiveSelector = [
    'button', 'input', 'textarea', 'select', 'a[href]', '[role="button"]',
    '[role="combobox"]', '[role="option"]', '[role="checkbox"]',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');
  const observationSelector = 'h1,h2,h3,[role="status"],[role="alert"],[data-result],[data-summary]';
  const ID_ATTR = 'data-dsh-decision-id';
  const TOKEN_ATTR = 'data-dsh-decision-token';
  // Provider-owned state: a random key so the page cannot address it by name.
  const STATE_ATTR = 'data-dsh-stage';

  // BR-14: an id from an earlier snapshot must not survive into this one, or a
  // single decision id would resolve to two nodes after a scroll.
  for (const stale of Array.from(document.querySelectorAll('[' + TOKEN_ATTR + ']'))) {
    stale.removeAttribute(TOKEN_ATTR);
    stale.removeAttribute(ID_ATTR);
  }
  document.documentElement.removeAttribute(STATE_ATTR);

  const nodes = [...new Set([
    ...document.querySelectorAll(interactiveSelector),
    ...document.querySelectorAll(observationSelector)
  ])];
  const visible = el => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
      style.visibility !== 'hidden' && rect.bottom >= 0 && rect.right >= 0 &&
      rect.top <= innerHeight && rect.left <= innerWidth;
  };
  const enabled = el => !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  const name = el => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) return labelledBy.split(/\\s+/).map(id =>
      document.getElementById(id)?.textContent || '').join(' ').trim();
    if (el.labels && el.labels.length) return [...el.labels].map(x => x.textContent).join(' ').trim();
    const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
    if (text) return text.slice(0, 300);
    return (el.getAttribute('placeholder') || el.getAttribute('title') || '').trim();
  };
  const role = el => {
    if (el.getAttribute('role')) return el.getAttribute('role');
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      if (el.type === 'checkbox' || el.type === 'radio') return el.type;
      if (el.type === 'number') return 'spinbutton';
      if (el.type === 'button' || el.type === 'submit') return 'button';
      return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'a') return 'link';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return tag;
  };
  const context = el => {
    const section = el.closest('section,fieldset,[role="group"],[role="region"],[data-context]');
    if (!section) return '';
    const heading = section.querySelector('h1,h2,h3,legend,[role="heading"]');
    return heading ? heading.textContent.trim().replace(/\\s+/g, ' ').slice(0, 160) : '';
  };
  const actions = el => {
    const tag = el.tagName.toLowerCase();
    if (!enabled(el)) return [];
    if (tag === 'input') {
      if (['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date'].includes(el.type)) {
        const result = ['click', 'type'];
        if (el.type === 'number') result.push('increment', 'decrement');
        return result;
      }
      return ['click'];
    }
    if (tag === 'textarea') return ['click', 'type'];
    const explicitRole = el.getAttribute('role');
    if (['button', 'link', 'option', 'checkbox', 'combobox', 'menuitem', 'tab'].includes(explicitRole)) {
      return ['click'];
    }
    if (tag === 'button' || tag === 'a' || tag === 'select' || el.hasAttribute('tabindex')) return ['click'];
    return [];
  };
  const elements = [];
  const observed = [];
  for (const el of nodes) {
    if (!visible(el)) continue;
    const id = 'e' + (elements.length + 1);
    el.setAttribute(ID_ATTR, id);
    el.setAttribute(TOKEN_ATTR, snapshotId + '-' + id);
    const tag = el.tagName.toLowerCase();
    // The value of a secret field never leaves the page; the metadata the
    // credential gate needs (input type, autocomplete, form context) still does.
    const isField = tag === 'input' || tag === 'textarea' || tag === 'select';
    const elementRecord = {
      id, role: role(el), name: name(el),
      value: isField ? (
        (el.type === 'checkbox' || el.type === 'radio') ? (el.checked ? 'checked' : 'unchecked') : el.value
      ) : null,
      actions: actions(el), enabled: enabled(el),
      focused: document.activeElement === el,
      inputType: tag === 'input' ? el.type : null,
      autocomplete: isField ? (el.getAttribute('autocomplete') || null) : null,
      context: context(el)
    };
    // Masking uses the provider's own classifier, so the page cannot decide
    // which of its fields count as secret.
    if (isSensitiveInput(elementRecord)) {
      elementRecord.sensitive = true;
      elementRecord.value = (elementRecord.value === null || elementRecord.value === '') ? elementRecord.value : '•••';
    }
    elements.push(elementRecord);
    observed.push(el);
    if (elements.length >= maxElements) break;
  }
  // Read after tagging, and published immediately: from here on the observer's
  // counter only moves when the page itself mutates the document.
  const state = window.__dshDecisionState;
  const version = state && typeof state.version === 'number' ? state.version : 0;
  // The handles below are collected against exactly this stage, in this order.
  window.__dshDecisionStage = snapshotId + '-' + version;
  document.documentElement.setAttribute(STATE_ATTR, snapshotId + '-' + version);
  // Same order as the element records above; the provider binds these to ids.
  window.__dshDecisionNodes = observed;
  const root = document.documentElement;
  return {
    snapshot_id: snapshotId,
    version: version,
    url: location.href,
    title: document.title,
    elements,
    truncated: nodes.length > elements.length,
    can_scroll_up: scrollY > 0,
    can_scroll_down: scrollY + innerHeight < root.scrollHeight - 2
  };
}`

const FRESHNESS_SCRIPT = `({url, target, stage, version}) => {
  const ID_ATTR = 'data-dsh-decision-id';
  const TOKEN_ATTR = 'data-dsh-decision-token';
  const STATE_ATTR = 'data-dsh-stage';
  if (location.href !== url) return {ok: false, reason: 'navigation_changed'};
  const state = window.__dshDecisionState;
  if (!state || typeof state.version !== 'number') return {ok: false, reason: 'observer_missing'};
  // Primary signal: the provider's recorded counter, in provider memory.
  if (state.version !== version) return {ok: false, reason: 'dom_changed'};
  // Secondary signal: the stage the snapshot published must still be there.
  if (document.documentElement.getAttribute(STATE_ATTR) !== stage) {
    return {ok: false, reason: 'state_missing'};
  }
  if (target) {
    const matches = document.querySelectorAll('[' + ID_ATTR + '="' + target + '"]');
    if (matches.length !== 1) return {ok: false, reason: 'target_ambiguous'};
    const el = matches[0];
    if (window.__dshDecisionStage !== stage) return {ok: false, reason: 'state_replaced'};
    const index = Number(target.slice(1)) - 1;
    const registry = window.__dshDecisionNodes;
    if (typeof registry === 'number' && registry <= index) return {ok: false, reason: 'target_missing'};
    const snapshotId = stage.slice(0, stage.lastIndexOf('-'));
    if (el.getAttribute(TOKEN_ATTR) !== snapshotId + '-' + target) {
      return {ok: false, reason: 'target_token_mismatch'};
    }
    if (!el.isConnected) return {ok: false, reason: 'target_missing'};
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (el.disabled || el.getAttribute('aria-disabled') === 'true' || !rect.width || !rect.height ||
        style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') {
      return {ok: false, reason: 'target_not_actionable'};
    }
  }
  return {ok: true};
}`

export class StaleSnapshot extends Error {}

import { stripTabMarker } from './tab-marker.ts'

/** One issued snapshot: what the provider saw, and what proves it is unchanged. */
interface SnapshotRecord {
  observation: Observation
  /** `"<snapshotId>-<version>"`, as published in `data-dsh-stage`. */
  stage: string
  /** Page mutation counter recorded in provider memory at snapshot time. */
  version: number
  /** Live handles for every observed element, indexed by decision id (BR-01). */
  handles: Map<string, ElementHandle<Element>>
}

export class BrowserDom {
  private counter = 0
  private latest?: SnapshotRecord
  private readonly issued = new WeakMap<Observation, SnapshotRecord>()
  constructor(
    private readonly page: Page,
    private readonly maxElements = 60,
    private readonly indicator?: ActivitySink,
    private readonly tabMark = '',
  ) {}

  /**
   * Arms the mutation observer for the current document. Idempotent per
   * document (the page-side state carries a bootstrap id), and re-armed on every
   * snapshot so a page that replaced the state object gets a working observer
   * back instead of silently disabling detection.
   */
  private async armObserver(): Promise<void> {
    const armed = await this.page.evaluate(INSTALL_OBSERVER_SCRIPT) as unknown
    if (armed !== true) throw new Error('Snapshot observer could not be installed')
  }

  async snapshot(): Promise<Observation> {
    this.counter += 1
    await this.armObserver()
    const observation = await this.page.evaluate(
      `(${SNAPSHOT_SCRIPT})(${JSON.stringify({
        snapshotId: `s${this.counter}`, maxElements: this.maxElements,
      })})`,
    ) as Observation
    // The provider's own tab marker is not page content: never feed it to a
    // decision, a verification assertion, or a published Skill.
    const clean = { ...observation, title: stripTabMarker(observation.title, this.tabMark) }
    const [stage, version, handles] = await this.bindObservedNodes(clean)
    // A page that mutated the document while the snapshot was being taken has
    // already invalidated it: report it as such instead of pretending it is
    // fresh (the caller turns this into a stale retry).
    const record: SnapshotRecord = { stage, version, handles, observation: clean }
    this.latest = record
    this.issued.set(clean, record)
    return clean
  }

  /**
   * Binds the snapshot to live node handles. The page-side registry is written
   * by SNAPSHOT_SCRIPT in the same task as the snapshot, so the registry order
   * is exactly the id order the agent saw.
   */
  private async bindObservedNodes(
    observation: Observation,
  ): Promise<[string, number, Map<string, ElementHandle<Element>>]> {
    const registry = await this.page.evaluate(() => {
      const page = globalThis as unknown as {
        __dshDecisionStage?: string
        __dshDecisionState?: { version?: unknown }
        __dshDecisionNodes?: Element[]
      }
      return {
        stage: document.documentElement.getAttribute('data-dsh-stage') ?? page.__dshDecisionStage ?? '',
        version: typeof page.__dshDecisionState?.version === 'number' ? page.__dshDecisionState.version : -1,
        nodeCount: Array.isArray(page.__dshDecisionNodes) ? page.__dshDecisionNodes.length : 0,
      }
    })
    const handles = new Map<string, ElementHandle<Element>>()
    for (const [index, element] of observation.elements.entries()) {
      if (index >= registry.nodeCount) break
      // One handle per id, taken by position in the registry the snapshot wrote
      // in the same task. Everything later compares against this node.
      const state = await this.page.evaluateHandle((position: number) => {
        const page = globalThis as unknown as { __dshDecisionNodes?: Element[] }
        return page.__dshDecisionNodes?.[position]
      }, index)
      const elementHandle = state.asElement() as ElementHandle<Element> | null
      if (elementHandle === null) {
        await state.dispose()
        break
      }
      handles.set(element.id, elementHandle)
    }
    return [String(registry.stage), Number(registry.version), handles]
  }

  /** True when the observation was issued by this instance and is still current. */
  isCurrent(snapshot: Observation): boolean {
    return this.issued.has(snapshot) && this.latest?.observation === snapshot
  }

  private async assertFresh(snapshot: Observation, target?: string | null): Promise<void> {
    const record = this.issued.get(snapshot)
    if (record === undefined) throw new StaleSnapshot('unknown_snapshot')
    if (this.latest?.observation !== snapshot) throw new StaleSnapshot('superseded_snapshot')
    const result = await this.page.evaluate(
      `(${FRESHNESS_SCRIPT})(${JSON.stringify({
        url: snapshot.url, target: target ?? null, stage: record.stage, version: record.version,
      })})`,
    ) as { ok: boolean; reason?: string }
    if (!result.ok) throw new StaleSnapshot(result.reason)
    if (target !== undefined && target !== null) {
      // The authoritative check: the node the agent was shown must still be the
      // node behind this handle, connected to this document.
      const handle = record.handles.get(target)
      if (handle === undefined) throw new StaleSnapshot('target_missing')
      const alive = await handle.evaluate(element => element.isConnected).catch(() => false)
      if (!alive) throw new StaleSnapshot('target_detached')
    }
  }

  /**
   * The retained handle for one id. Dispatch always goes through this node, so
   * re-pointing `data-dsh-decision-id` in the page cannot redirect the input
   * (BR-01); a missing handle is a stale snapshot, never a fresh lookup.
   */
  private handleFor(snapshot: Observation, target: string): ElementHandle<Element> {
    const record = this.issued.get(snapshot)
    const handle = record?.handles.get(target)
    if (handle === undefined) throw new StaleSnapshot('target_missing')
    return handle
  }

  async execute(snapshot: Observation, decision: Decision, timeoutMs: number): Promise<void> {
    const operation = decision.operation
    if (operation === 'WAIT') {
      await this.indicator?.activity({ phase: 'waiting', operation })
      await this.page.waitForTimeout(250)
      return
    }
    if (operation === 'SCROLL_UP' || operation === 'SCROLL_DOWN') {
      await this.assertFresh(snapshot)
      const point = await this.page.evaluate(() => ({ x: innerWidth / 2, y: innerHeight / 2 }))
      await this.indicator?.activity({ phase: 'acting', operation, point })
      await this.page.evaluate(direction => window.scrollBy(0, direction * innerHeight * 0.75),
        operation === 'SCROLL_UP' ? -1 : 1)
      await this.page.waitForTimeout(100)
      return
    }
    await this.assertFresh(snapshot, decision.target)
    // Dispatch through the retained node, never through a re-resolved selector:
    // a page that moves `data-dsh-decision-id` cannot redirect this call.
    const target = this.handleFor(snapshot, decision.target!)
    const bounds = await target.boundingBox()
    const point = bounds === null ? undefined : { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
    await this.indicator?.activity({ phase: 'acting', operation, point })
    try {
      if (operation === 'CLICK') await target.click({ timeout: timeoutMs, noWaitAfter: true })
      else if (operation === 'TYPE_TEXT') await target.fill(decision.text!, { timeout: timeoutMs })
      else if (operation === 'INCREMENT' || operation === 'DECREMENT') {
        await target.press(operation === 'INCREMENT' ? 'ArrowUp' : 'ArrowDown', { timeout: timeoutMs })
      } else throw new Error(`Unsupported executable operation: ${operation}`)
    } catch (error) {
      // The page may move the target between the freshness check and dispatch.
      // A detached node or a strict-mode failure means the target is gone, which
      // the caller retries as a stale decision instead of crashing the run.
      const detail = error instanceof Error ? error.message : String(error)
      if (/strict mode violation|not attached|detached|element is not visible|Element is not attached/iu.test(detail)) {
        throw new StaleSnapshot('target_changed_during_dispatch')
      }
      throw error
    }
  }

  /** Releases the retained handles of the newest snapshot (page close/teardown). */
  async dispose(): Promise<void> {
    for (const [, handle] of this.latest?.handles ?? []) await handle.dispose().catch(() => undefined)
    this.latest = undefined
  }
}

export { validateDecision } from '@albaincompleta/dsh-cu-core/actions'

/**
 * Page-normalized text: collapse every whitespace run, trim, keep case. The
 * comparison is deliberately case-sensitive — "Saved" and "saved" are different
 * copies on a hostile page, and only an exact match is evidence.
 */
function normalizeText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

/** Elements whose own text is compared; text nodes are folded into their block. */
const TEXT_BLOCK_SELECTOR =
  'h1,h2,h3,h4,h5,h6,p,li,td,th,dd,dt,div,span,label,button,a,option,legend,figcaption,caption,pre,code,em,strong,b,i,small,blockquote,summary,section,article,footer,header,main,aside,nav,form,fieldset,[role],[data-result],[data-summary]'

/**
 * Every visible element whose normalized text equals the assertion. Nested
 * elements repeat the same text by design (`<div><span>x</span></div>`), so the
 * count is de-duplicated by text: what matters is that exactly one rendered text
 * block matches, and that the page cannot satisfy the assertion by shipping two
 * copies of it (BR-04).
 */
async function exactVisibleTextCount(page: Page, text: string): Promise<number> {
  const wanted = normalizeText(text)
  if (wanted === '') return 0
  return await page.evaluate(({ selector, wanted }: { selector: string; wanted: string }) => {
    const normalize = (value: string): string => value.replace(/\s+/gu, ' ').trim()
    const visible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
        style.visibility !== 'hidden' && style.opacity !== '0'
    }
    const matches: Element[] = []
    for (const element of Array.from(document.querySelectorAll(selector))) {
      const text = normalize(element.textContent ?? '')
      if (text !== wanted) continue
      if (!visible(element)) continue
      // Ignore a wrapper that only repeats its single child; the child is the
      // copy the page actually renders.
      matches.push(element)
    }
    return matches.filter(element =>
      !matches.some(other => other !== element && element.contains(other)),
    ).length
  }, { selector: TEXT_BLOCK_SELECTOR, wanted })
}

/** True only when the box has area, is styled visible, and sits in the viewport. */
async function isRenderedInViewport(locator: ReturnType<Page['locator']>): Promise<boolean> {
  return await locator.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    if (rect.width <= 0 || rect.height <= 0) return false
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
    return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth
  }).catch(() => false)
}

/**
 * Resolves an accessible label to exactly one rendered, enabled control.
 *
 * Label lookup is a discovery aid, never proof of a value: `getByLabel` happily
 * returns `type=hidden` inputs, aria-label mirrors and off-viewport decoys, so
 * every candidate must also be rendered inside the viewport and enabled. A
 * duplicated label fails closed rather than picking one (BR-05).
 */
async function uniqueLabelledControl(page: Page, label: string): Promise<ReturnType<Page['locator']>> {
  const matches = page.getByLabel(label, { exact: true })
  const count = await matches.count()
  if (count !== 1) throw new Error('label_not_unique')
  const control = matches.first()
  if (!await control.isVisible()) throw new Error('label_hidden')
  if (!await control.isEnabled()) throw new Error('label_disabled')
  if (!await isRenderedInViewport(control)) throw new Error('label_not_rendered')
  return control
}

/** True when a URL names a cloud instance-metadata service (link-local / local). */
const METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
])

function ipv4Bytes(host: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host)
  if (match === null) return null
  const bytes = match.slice(1).map(Number)
  return bytes.every(byte => byte <= 255) ? bytes : null
}

/**
 * True for endpoints that only exist to hand out credentials: AWS/GCP/Azure
 * instance metadata (link-local 169.254.0.0/16, the Alibaba/Tencent
 * 100.100.100.200 service address, the AWS IPv6 IMDS address) and the
 * well-known metadata host names. Loopback and private ranges stay reachable on
 * purpose: local fixtures and local services are a supported workflow (BR-10).
 */
export function isMetadataDestination(raw: string | URL): boolean {
  let url: URL
  try {
    url = typeof raw === 'string' ? new URL(raw) : raw
  } catch {
    return false
  }
  const host = url.hostname.replace(/^\[|\]$/gu, '').replace(/\.$/u, '').toLowerCase()
  if (METADATA_HOSTS.has(host) || host.endsWith('.internal') || host.endsWith('.local')) return true
  const bytes = ipv4Bytes(host)
  if (bytes !== null) {
    if (bytes[0] === 169 && bytes[1] === 254) return true
    if (bytes[0] === 100 && bytes[1] === 100 && bytes[2] === 100 && bytes[3] === 200) return true
  }
  const ipv6 = host.toLowerCase()
  // fd00:ec2::254 is the AWS IPv6 metadata endpoint; fe80::/10 is link-local.
  if (ipv6 === 'fd00:ec2::254' || /^fe[89ab][0-9a-f]?:/u.test(ipv6)) return true
  return false
}

/**
 * `url_contains` with a boundary: the expected value is compared as an origin
 * and/or a path prefix of the *actual* URL, never as raw text (BR-06).
 *
 * - `https://example.com` matches only that origin (scheme, host, port);
 * - `example.com` is read as a host and matched as an origin host, so
 *   `example.com.evil.tld` and `evil.tld/?next=example.com` never match;
 * - `/dashboard` is matched against the pathname as a segment prefix, so
 *   `/dash` does not match `/dashboard`;
 * - anything unparseable fails closed.
 */
export function urlSatisfies(rawActual: string, expectation: string): boolean {
  let actual: URL
  try {
    actual = new URL(rawActual)
  } catch {
    return false
  }
  const expected = expectation.trim()
  if (expected === '') return false
  if (expected.startsWith('/')) {
    // Path expectation, compared segment-wise: `/dash` never matches `/dashboard`.
    const expectedPath = expected.split(/[?#]/u)[0]!
    if (actual.pathname === expectedPath) return true
    return actual.pathname.startsWith(expectedPath.endsWith('/') ? expectedPath : `${expectedPath}/`)
  }
  // A bare host is resolved against a throwaway scheme, never against the
  // actual URL: `new URL('example.com', actual)` would be a *relative* path and
  // therefore inherit the very origin the assertion is trying to check.
  const hostLike = /^[a-z0-9.-]+(:\d+)?$/iu.test(expected.split(/[?#]/u)[0]!)
  const bareHost = expected.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, '').replace(/^\/\//u, '')
  let target: URL
  try {
    target = new URL(hostLike ? `https://${expected}` : expected, actual.origin)
  } catch {
    return false
  }
  if (target.origin !== actual.origin) return false
  // A bare host or origin names only the origin; an expectation that carries a
  // path must match it segment-wise as well.
  if (!bareHost.includes('/')) return true
  const expectedPath = target.pathname
  if (actual.pathname === expectedPath) return true
  return actual.pathname.startsWith(expectedPath.endsWith('/') ? expectedPath : `${expectedPath}/`)
}

/**
 * Evaluates every assertion against the owned page and fails closed: an
 * assertion that cannot be evaluated, cannot be resolved to exactly one visible
 * element, or is checked on a page that navigated to a metadata endpoint
 * verifies nothing.
 */
export async function verifyAll(page: Page, assertions: Verification[]): Promise<boolean> {
  try {
    if (isMetadataDestination(page.url())) return false
    for (const assertion of assertions) {
      if (assertion.type === 'text_visible') {
        if (await exactVisibleTextCount(page, assertion.text) !== 1) return false
      } else if (assertion.type === 'url_contains') {
        if (!urlSatisfies(page.url(), assertion.value)) return false
      } else if (assertion.type === 'input_value') {
        const control = await uniqueLabelledControl(page, assertion.label)
        if (await control.inputValue() !== assertion.value) return false
      } else if (assertion.type === 'checkbox') {
        const control = await uniqueLabelledControl(page, assertion.label)
        if (await control.isChecked() !== assertion.checked) return false
      } else {
        // Never treat an assertion this provider cannot evaluate as satisfied.
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

/**
 * Rejects assertions the browser provider cannot evaluate. Custom handlers are a
 * native-provider concept; silently ignoring them would report success without
 * ever checking the requested postcondition.
 */
export function assertSupportedAssertions(assertions: Verification[]): void {
  for (const assertion of assertions) {
    if (assertion.type === 'custom') {
      throw new Error(
        `Unsupported verification assertion: custom handler "${assertion.name}" is not available in the browser provider`,
      )
    }
  }
}

export async function hasPendingUi(page: Page): Promise<boolean> {
  const indicators = page.locator('[aria-busy="true"],[role="status"],[role="alert"]')
  for (let index = 0; index < await indicators.count(); index += 1) {
    const indicator = indicators.nth(index)
    if (!await indicator.isVisible()) continue
    const text = await indicator.innerText().catch(() => '')
    if (/loading|waiting|please wait|加载|等待/iu.test(text)) return true
  }
  return false
}

/** True for a navigation failure that is really "the destination is forbidden". */
export function isBlockedDestinationError(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error)
  return /ERR_UNSAFE_PORT|ERR_BLOCKED|ERR_ADDRESS_UNREACHABLE|ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED/iu.test(detail)
}

/**
 * Validates a navigation destination. HTTP(S) only, no embedded credentials, and
 * never a cloud-metadata endpoint — before the request, and again after any
 * redirect (callers re-check `page.url()`, see navigate.ts). The metadata hosts
 * are link-local/private addresses the browser refuses anyway; the point of the
 * check is to make the refusal explicit and uniform before the request leaves.
 */
export function navigationUrl(raw: string): string {
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Browser navigation requires an HTTP(S) URL without embedded credentials')
  }
  if (isMetadataDestination(url)) {
    throw new Error('Browser navigation refuses cloud metadata endpoints')
  }
  return url.toString()
}
