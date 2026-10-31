import type { Page } from 'playwright'
import type { Decision } from './decision.ts'


import type { ObservedElement, Observation } from '@dsh-cu/core/types'
import type { ActivitySink } from '@dsh-cu/core/activity'
import type { Verification } from '@dsh-cu/core/contract'

export type { ObservedElement, Observation } from '@dsh-cu/core/types'
export { verificationSchema } from '@dsh-cu/core/contract'

const OBSERVER_SCRIPT = `(() => {
  if (window.__dshDecisionObserver) return;
  window.__dshDecisionVersion = 0;
  window.__dshDecisionObserver = true;
  const bump = () => { window.__dshDecisionVersion += 1; };
  new MutationObserver(bump).observe(document.documentElement, {
    subtree: true, childList: true, characterData: true
  });
  document.addEventListener('input', bump, true);
  document.addEventListener('change', bump, true);
})()`

const SNAPSHOT_SCRIPT = `({snapshotId, maxElements}) => {
  const interactiveSelector = [
    'button', 'input', 'textarea', 'select', 'a[href]', '[role="button"]',
    '[role="combobox"]', '[role="option"]', '[role="checkbox"]',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');
  const observationSelector = 'h1,h2,h3,[role="status"],[role="alert"],[data-result],[data-summary]';
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
  for (const el of nodes) {
    if (!visible(el)) continue;
    const id = \`e\${elements.length + 1}\`;
    el.setAttribute('data-dsh-decision-id', id);
    const tag = el.tagName.toLowerCase();
    let value = null;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      value = (el.type === 'checkbox' || el.type === 'radio') ? (el.checked ? 'checked' : 'unchecked') : el.value;
    }
    elements.push({
      id, role: role(el), name: name(el), value, actions: actions(el), enabled: enabled(el),
      focused: document.activeElement === el,
      inputType: tag === 'input' ? el.type : null,
      context: context(el)
    });
    if (elements.length >= maxElements) break;
  }
  const root = document.documentElement;
  return {
    snapshot_id: snapshotId,
    version: window.__dshDecisionVersion || 0,
    url: location.href,
    title: document.title,
    elements,
    truncated: nodes.length > elements.length,
    can_scroll_up: scrollY > 0,
    can_scroll_down: scrollY + innerHeight < root.scrollHeight - 2
  };
}`

const FRESHNESS_SCRIPT = `({version, url, target}) => {
  if (location.href !== url) return {ok: false, reason: 'navigation_changed'};
  if ((window.__dshDecisionVersion || 0) !== version) return {ok: false, reason: 'dom_changed'};
  if (target) {
    const el = document.querySelector(\`[data-dsh-decision-id="\${target}"]\`);
    if (!el) return {ok: false, reason: 'target_missing'};
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (el.disabled || el.getAttribute('aria-disabled') === 'true' || !rect.width || !rect.height ||
        style.display === 'none' || style.visibility === 'hidden') {
      return {ok: false, reason: 'target_not_actionable'};
    }
  }
  return {ok: true};
}`

export class StaleSnapshot extends Error {}

import { stripTabMarker } from './tab-marker.ts'

export class BrowserDom {
  private counter = 0
  constructor(
    private readonly page: Page,
    private readonly maxElements = 60,
    private readonly indicator?: ActivitySink,
    private readonly tabMark = '',
  ) {}

  async snapshot(): Promise<Observation> {
    await this.page.evaluate(OBSERVER_SCRIPT)
    this.counter += 1
    const observation = await this.page.evaluate(
      `(${SNAPSHOT_SCRIPT})(${JSON.stringify({ snapshotId: `s${this.counter}`, maxElements: this.maxElements })})`,
    ) as Observation
    // The provider's own tab marker is not page content: never feed it to a
    // decision, a verification assertion, or a published Skill.
    return { ...observation, title: stripTabMarker(observation.title, this.tabMark) }
  }

  private async assertFresh(snapshot: Observation, target?: string | null): Promise<void> {
    const result = await this.page.evaluate(
      `(${FRESHNESS_SCRIPT})(${JSON.stringify({ version: snapshot.version, url: snapshot.url, target: target ?? null })})`,
    ) as { ok: boolean; reason?: string }
    if (!result.ok) throw new StaleSnapshot(result.reason)
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
    const locator = this.page.locator(`[data-dsh-decision-id="${decision.target}"]`)
    const bounds = await locator.boundingBox()
    const point = bounds === null ? undefined : { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
    await this.indicator?.activity({ phase: 'acting', operation, point })
    if (operation === 'CLICK') await locator.click({ timeout: timeoutMs, noWaitAfter: true })
    else if (operation === 'TYPE_TEXT') await locator.fill(decision.text!, { timeout: timeoutMs })
    else if (operation === 'INCREMENT' || operation === 'DECREMENT') {
      await locator.press(operation === 'INCREMENT' ? 'ArrowUp' : 'ArrowDown', { timeout: timeoutMs })
    } else throw new Error(`Unsupported executable operation: ${operation}`)
  }
}

export { validateDecision } from '@dsh-cu/core/actions'

export async function verifyAll(page: Page, assertions: Verification[]): Promise<boolean> {
  try {
    for (const assertion of assertions) {
      if (assertion.type === 'text_visible') {
        if (!await page.getByText(assertion.text, { exact: false }).first().isVisible()) return false
      } else if (assertion.type === 'url_contains') {
        if (!page.url().includes(assertion.value)) return false
      } else if (assertion.type === 'input_value') {
        if (await page.getByLabel(assertion.label, { exact: true }).inputValue() !== assertion.value) return false
      } else if (assertion.type === 'checkbox') {
        if (await page.getByLabel(assertion.label, { exact: true }).isChecked() !== assertion.checked) return false
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

export function navigationUrl(raw: string): string {
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Browser navigation requires an HTTP(S) URL without embedded credentials')
  }
  return url.toString()
}
