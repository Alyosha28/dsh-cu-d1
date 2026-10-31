from __future__ import annotations

from typing import Any

from playwright.sync_api import Page


OBSERVER_SCRIPT = r"""
(() => {
  if (window.__dshDecisionObserver) return;
  window.__dshDecisionVersion = 0;
  window.__dshDecisionObserver = true;
  const bump = () => { window.__dshDecisionVersion += 1; };
  new MutationObserver(bump).observe(document.documentElement, {
    subtree: true, childList: true, characterData: true
  });
  document.addEventListener('input', bump, true);
  document.addEventListener('change', bump, true);
})()
"""


SNAPSHOT_SCRIPT = r"""
({snapshotId, maxElements}) => {
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
    if (labelledBy) return labelledBy.split(/\s+/).map(id =>
      document.getElementById(id)?.textContent || '').join(' ').trim();
    if (el.labels && el.labels.length) return [...el.labels].map(x => x.textContent).join(' ').trim();
    const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
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
    const id = `e${elements.length + 1}`;
    el.setAttribute('data-dsh-decision-id', id);
    const tag = el.tagName.toLowerCase();
    let value = null;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      value = (el.type === 'checkbox' || el.type === 'radio') ? (el.checked ? 'checked' : 'unchecked') : el.value;
    }
    elements.push({
      id, role: role(el), name: name(el), value, actions: actions(el), enabled: enabled(el),
      focused: document.activeElement === el
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
}
"""


FRESHNESS_SCRIPT = r"""
({version, url, target}) => {
  if (location.href !== url) return {ok: false, reason: 'navigation_changed'};
  if ((window.__dshDecisionVersion || 0) !== version) return {ok: false, reason: 'dom_changed'};
  if (target) {
    const el = document.querySelector(`[data-dsh-decision-id="${target}"]`);
    if (!el) return {ok: false, reason: 'target_missing'};
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (el.disabled || el.getAttribute('aria-disabled') === 'true' || !rect.width || !rect.height ||
        style.display === 'none' || style.visibility === 'hidden') {
      return {ok: false, reason: 'target_not_actionable'};
    }
  }
  return {ok: true};
}
"""


class StaleSnapshot(RuntimeError):
    pass


class BrowserDriver:
    """Small DOM driver used to test the decision protocol, not a DSH provider yet."""

    def __init__(self, page: Page, max_elements: int = 60) -> None:
        self.page = page
        self.max_elements = max_elements
        self.snapshot_counter = 0

    def snapshot(self) -> dict[str, Any]:
        self.page.evaluate(OBSERVER_SCRIPT)
        self.snapshot_counter += 1
        return self.page.evaluate(
            SNAPSHOT_SCRIPT,
            {"snapshotId": f"s{self.snapshot_counter}", "maxElements": self.max_elements},
        )

    def _assert_fresh(self, snapshot: dict[str, Any], target: str | None = None) -> None:
        result = self.page.evaluate(
            FRESHNESS_SCRIPT,
            {"version": snapshot["version"], "url": snapshot["url"], "target": target},
        )
        if not result["ok"]:
            raise StaleSnapshot(result["reason"])

    def execute(self, snapshot: dict[str, Any], decision: dict[str, Any]) -> dict[str, Any]:
        operation = decision["operation"]
        target = decision.get("target")
        if operation == "WAIT":
            self.page.wait_for_timeout(250)
            return {"dispatched": True, "operation": operation}
        if operation in {"SCROLL_UP", "SCROLL_DOWN"}:
            self._assert_fresh(snapshot)
            direction = -1 if operation == "SCROLL_UP" else 1
            self.page.evaluate("direction => window.scrollBy(0, direction * innerHeight * 0.75)", direction)
            self.page.wait_for_timeout(100)
            return {"dispatched": True, "operation": operation}

        self._assert_fresh(snapshot, target)
        locator = self.page.locator(f'[data-dsh-decision-id="{target}"]')
        if operation == "CLICK":
            locator.click(timeout=1500)
        elif operation == "TYPE_TEXT":
            locator.fill(decision["text"], timeout=1500)
        elif operation in {"INCREMENT", "DECREMENT"}:
            locator.press("ArrowUp" if operation == "INCREMENT" else "ArrowDown", timeout=1500)
        else:
            raise ValueError(f"Unsupported executable operation: {operation}")
        return {"dispatched": True, "operation": operation, "target": target}
