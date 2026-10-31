import type { BrowserContext, Page } from 'playwright'

/**
 * What the user should still see after taking over a launch-mode page: the same
 * URL, cookies, local storage, session storage, scroll position, and whatever
 * was already typed into the form.
 *
 * `storageState` covers cookies and local storage. Session storage, scroll, and
 * form values are page state and must be captured and restored explicitly.
 */
export interface TakeoverState {
  url: string
  origin: string
  sessionStorage: Array<[string, string]>
  scrollY: number
  fields: Array<{
    index: number
    id: string
    name: string
    tag: string
    type: string
    value?: string
    checked?: boolean
  }>
}

interface CapturedFormField {
  index: number
  id: string
  name: string
  tag: string
  type: string
  value: string
  checked: boolean
}

const FIELD_SELECTOR = 'input, textarea, select'

/**
 * Reads the state worth preserving. Returns undefined when the page cannot be
 * read (closed, crashed, or cross-origin), so takeover still opens the URL
 * instead of failing the whole run.
 */
export async function captureTakeoverState(page: Page): Promise<TakeoverState | undefined> {
  try {
    const snapshot = await page.evaluate((selector: string) => {
      const fields = Array.from(document.querySelectorAll(selector)).map((element, index) => {
        const field = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
        return {
          index,
          id: field.id,
          name: field.name,
          tag: field.tagName.toLowerCase(),
          type: 'type' in field ? field.type : '',
          value: field.value ?? '',
          checked: 'checked' in field ? Boolean(field.checked) : false,
        }
      })
      return {
        origin: location.origin,
        sessionStorage: Object.entries(sessionStorage) as Array<[string, string]>,
        scrollY: window.scrollY,
        fields,
      }
    }, FIELD_SELECTOR)
    return {
      url: page.url(),
      origin: snapshot.origin,
      sessionStorage: snapshot.sessionStorage,
      scrollY: snapshot.scrollY,
      fields: (snapshot.fields as CapturedFormField[]).map(field => ({
        index: field.index,
        id: field.id,
        name: field.name,
        tag: field.tag,
        type: field.type,
        ...field.type === 'checkbox' || field.type === 'radio'
          ? { checked: field.checked }
          : { value: field.value },
      })),
    }
  } catch {
    return undefined
  }
}

/**
 * Installs session storage before any page script runs. Session storage is
 * origin-scoped and per-tab, so it has to be seeded on the new tab.
 */
export async function installSessionStorageRestore(
  context: BrowserContext,
  state: TakeoverState,
): Promise<void> {
  if (state.sessionStorage.length === 0) return
  await context.addInitScript(({ origin, entries }: { origin: string; entries: Array<[string, string]> }) => {
    if (location.origin !== origin) return
    for (const [key, value] of entries) {
      try {
        sessionStorage.setItem(key, value)
      } catch {
        // Storage can be blocked by policy; the rest of the takeover still works.
      }
    }
  }, { origin: state.origin, entries: state.sessionStorage })
}

/**
 * Restores form values and scroll position after navigation. Fields are matched
 * by their order in the same document; a changed page shape leaves the
 * unmatched fields alone rather than writing values into the wrong control.
 */
export async function restoreTakeoverState(page: Page, state: TakeoverState): Promise<void> {
  try {
    await page.evaluate(({ fields, scrollY }: Pick<TakeoverState, 'fields' | 'scrollY'>) => {
      const elements = Array.from(document.querySelectorAll('input, textarea, select'))
      for (const field of fields) {
        // A captured id or name is an identity: when it is gone, the control is
        // gone too. Only anonymous controls fall back to their position.
        const byId = field.id === '' ? undefined : document.getElementById(field.id)
        const byName = field.id === '' && field.name !== ''
          ? elements.filter(element => (element as HTMLInputElement).name === field.name)
          : []
        const byIndex = field.id === '' && field.name === '' ? elements[field.index] : undefined
        const candidate = byId ?? (byName.length === 1 ? byName[0] : undefined) ?? byIndex
        if (candidate === undefined || candidate === null) continue
        // Only write into a control with the same shape: a changed page must not
        // receive a value that belonged to a different field.
        if (candidate.tagName.toLowerCase() !== field.tag) continue
        if ((candidate as HTMLInputElement).type !== field.type) continue
        const element = candidate as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
        if (field.checked !== undefined) {
          const checkable = element as HTMLInputElement
          if (checkable.type === 'checkbox' || checkable.type === 'radio') checkable.checked = field.checked
          continue
        }
        if (field.value === undefined) continue
        element.value = field.value
        element.dispatchEvent(new Event('input', { bubbles: true }))
        element.dispatchEvent(new Event('change', { bubbles: true }))
      }
      window.scrollTo(0, scrollY)
    }, { fields: state.fields, scrollY: state.scrollY })
  } catch {
    // The takeover page stays usable even when the source state is gone.
  }
}
