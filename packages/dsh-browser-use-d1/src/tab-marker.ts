import type { Page } from 'playwright'

/** Removes this provider's own tab marker from a title it reports back. */
export function stripTabMarker(title: string, label: string): string {
  const prefix = `● ${label} · `
  return title.startsWith(prefix) ? title.slice(prefix.length) : title
}

/** Reads the page title without the tab marker the provider added. */
export async function readPageTitle(page: Page, label: string): Promise<string> {
  const title = await page.title().catch(() => '')
  return stripTabMarker(title, label)
}

/**
 * Marks the controlled tab itself, not just the page body.
 *
 * The in-page overlay lives inside the viewport and disappears from view when
 * the user looks at another tab, a background window, or the tab strip. A title
 * prefix and a favicon dot are visible in browser chrome, survive navigation,
 * and disappear when the run ends. The page still owns its own title: the
 * marker is re-applied after the page changes it or navigates.
 */
export class TabMarker {
  private active = false
  private readonly onNavigate = (): void => {
    if (this.active) void this.apply()
  }

  constructor(
    private readonly page: Page,
    private readonly label: string,
  ) {}

  async start(): Promise<void> {
    if (this.active) return
    this.active = true
    this.page.on('framenavigated', this.onNavigate)
    await this.apply()
  }

  async clear(): Promise<void> {
    if (!this.active) return
    this.active = false
    this.page.off('framenavigated', this.onNavigate)
    if (this.page.isClosed()) return
    await this.page.evaluate(() => {
      const state = (window as unknown as { __dshCuTabMarker?: MarkerState }).__dshCuTabMarker
      if (state === undefined) return
      state.observer?.disconnect()
      document.title = document.title.split(state.prefix).join('')
      for (const icon of state.icons) {
        if (icon.href === null) icon.element.removeAttribute('href')
        else icon.element.setAttribute('href', icon.href)
      }
      for (const injected of Array.from(document.querySelectorAll('link[data-dsh-cu-marker]'))) injected.remove()
      delete (window as unknown as { __dshCuTabMarker?: MarkerState }).__dshCuTabMarker
    }).catch(() => undefined)
  }

  private async apply(): Promise<void> {
    if (this.page.isClosed()) return
    await this.page.evaluate((label: string) => {
      const prefix = `● ${label} · `
      const dot = 'data:image/svg+xml,' + encodeURIComponent(
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='8' r='7' fill='%232b44b0'/><circle cx='8' cy='8' r='3' fill='white'/></svg>",
      )
      interface Marker {
        prefix: string
        observer?: MutationObserver
        icons: Array<{ element: HTMLLinkElement; href: string | null }>
      }
      const scope = window as unknown as { __dshCuTabMarker?: Marker }
      const state: Marker = scope.__dshCuTabMarker ?? { prefix, icons: [] }
      state.prefix = prefix
      const applyTitle = (): void => {
        if (!document.title.startsWith(prefix)) document.title = `${prefix}${document.title}`
      }
      if (state.observer === undefined) {
        state.observer = new MutationObserver(applyTitle)
        state.observer.observe(document.head ?? document.documentElement, {
          subtree: true, childList: true, characterData: true,
        })
      }
      if (state.icons.length === 0) {
        state.icons = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'))
          .map(element => ({ element, href: element.getAttribute('href') }))
      }
      if (state.icons.length === 0) {
        const injected = document.createElement('link')
        injected.rel = 'icon'
        injected.setAttribute('data-dsh-cu-marker', '')
        injected.href = dot
        ;(document.head ?? document.documentElement).append(injected)
      } else {
        for (const icon of state.icons) icon.element.setAttribute('href', dot)
      }
      scope.__dshCuTabMarker = state
      applyTitle()
    }, this.label).catch(() => undefined)
  }
}

interface MarkerState {
  prefix: string
  observer?: MutationObserver
  icons: Array<{ element: HTMLLinkElement; href: string | null }>
}
