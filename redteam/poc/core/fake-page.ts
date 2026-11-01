/**
 * Minimal duck-typed Playwright `Page` used by the red-team PoCs.
 *
 * It implements exactly the surface `runBrowserSkill` touches through
 * `BrowserDom` / `verifyAll`: evaluate(OBSERVER|SNAPSHOT|FRESHNESS),
 * url(), waitForTimeout(), locator(), getByText(), getByLabel().
 * Nothing here is a mock framework: the production `runBrowserSkill` code path
 * runs unmodified against it.
 */
import type { Observation, ObservedElement } from '../../../packages/dsh-cu-core/src/types.ts'

export interface ElementSpec extends Partial<ObservedElement> {
  name: string
}

export class FakePage {
  readonly clicked: string[] = []
  readonly typed: Array<{ target: string; text: string }> = []
  visible: string[] = []
  currentUrl: string
  title: string
  elements: ObservedElement[]
  /** Side effects a click performs, keyed by element name. */
  onClick: (name: string) => void = () => undefined

  constructor(url: string, elements: ElementSpec[], visible: string[] = [], title = 'Checkout') {
    this.currentUrl = url
    this.title = title
    this.visible = [...visible]
    this.elements = elements.map((spec, index) => ({
      id: spec.id ?? `e${index + 1}`,
      role: spec.role ?? 'button',
      name: spec.name,
      value: spec.value ?? null,
      actions: spec.actions ?? ['click'],
      enabled: spec.enabled ?? true,
      focused: false,
      ...spec.inputType === undefined ? {} : { inputType: spec.inputType },
      ...spec.identifier === undefined ? {} : { identifier: spec.identifier },
      ...spec.context === undefined ? {} : { context: spec.context },
      ...spec.bounds === undefined ? {} : { bounds: spec.bounds },
    }))
  }

  observation(): Observation {
    return {
      snapshot_id: 's1',
      version: 1,
      url: this.currentUrl,
      title: this.title,
      elements: this.elements,
      truncated: false,
      can_scroll_up: false,
      can_scroll_down: false,
    }
  }

  url(): string {
    return this.currentUrl
  }

  async evaluate(source: string | ((...args: unknown[]) => unknown)): Promise<unknown> {
    const script = typeof source === 'string' ? source : source.toString()
    if (script.includes('"maxElements"')) return this.observation()
    if (script.includes('"version"')) return { ok: true }
    return undefined
  }

  async waitForTimeout(): Promise<void> {
    return undefined
  }

  locator(selector: string): any {
    const match = /data-dsh-decision-id="([^"]+)"/u.exec(selector)
    if (match === null) {
      // The aria-busy / role=status probe used by hasPendingUi().
      return { count: async () => 0, nth: () => ({}) }
    }
    const id = match[1]
    const element = this.elements.find(item => item.id === id)
    return {
      boundingBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }),
      click: async () => {
        const name = element?.name ?? id
        this.clicked.push(name)
        this.onClick(name)
      },
      fill: async (text: string) => {
        this.typed.push({ target: element?.name ?? id, text })
      },
      press: async () => undefined,
      count: async () => 1,
      nth: () => this.locator(selector),
      first() {
        return this
      },
      isVisible: async () => true,
      inputValue: async () => element?.value ?? '',
      isChecked: async () => false,
    }
  }

  getByText(text: string): any {
    return {
      first: () => ({ isVisible: async () => this.visible.some(item => item.includes(text)) }),
      click: async () => this.clicked.push(text),
      count: async () => 1,
    }
  }

  getByLabel(label: string): any {
    const element = this.elements.find(item => item.name === label)
    return {
      inputValue: async () => element?.value ?? '',
      isChecked: async () => element?.selected === true,
      fill: async (text: string) => this.typed.push({ target: label, text }),
      first() {
        return this
      },
    }
  }

  async goto(): Promise<void> {
    return undefined
  }
}

export function asPage(page: FakePage): any {
  return page as unknown as any
}
