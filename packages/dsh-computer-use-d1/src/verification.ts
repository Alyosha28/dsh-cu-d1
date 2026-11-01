import type { Verification } from '@albaincompleta/dsh-cu-core/contract'
import type { ObservedElement } from '@albaincompleta/dsh-cu-core/types'


/**
 * Native verification: AX parsing, evidence, and the assertion evaluator.
 *
 * Two properties matter for every assertion:
 *
 * 1. **Evidence is bound to one element.** A result names the window, the AX
 *    index/identifier and the geometry it was read from, so "the text exists
 *    somewhere" can never satisfy an assertion.
 * 2. **The provider owns the read.** The caller supplies assertions, never the
 *    state, the window, or the evidence path; anything the provider cannot
 *    evaluate fails closed.
 */

export type Bounds4 = [number, number, number, number]

export interface WindowRect {
  x: number
  y: number
  width: number
  height: number
}

/** One parsed AX line. `bounds`/`inheritedBounds` are screen points (AX space). */
export interface AxNode {
  /** AX index when the helper assigned one; text leaves often have none. */
  index?: string
  role: string
  /** Quoted title that follows the role, e.g. `- AXButton "Save"`. */
  title: string
  /** `= "value"` / `value="..."`: the AXValue. */
  value: string | null
  identifier?: string
  description?: string
  placeholder?: string
  help?: string
  actions: string[]
  /** Own AX frame when the line carries one. */
  bounds?: Bounds4
  /** Nearest ancestor frame, used when the node itself carries no geometry. */
  inheritedBounds?: Bounds4
  hidden: boolean
  offscreen: boolean
  enabled: boolean
  focused: boolean
  depth: number
}

const LINE = /^(\s*)-(?:\s*\[(\d+)\])?\s+(\S+)(?:\s(.*))?$/u

function quoted(source: string, key: string): string | undefined {
  const match = source.match(new RegExp(`${key}="((?:[^"\\\\]|\\\\.)*)"`, 'u'))
  return match?.[1]
}

function flag(source: string, name: string): boolean {
  return new RegExp(`(?:^|\\s)${name}(?=\\s|$)`, 'u').test(source)
}

function frame(source: string, key: string): Bounds4 | undefined {
  const raw = source.match(new RegExp(`${key}=\\[([^\\]]+)\\]`, 'u'))?.[1]
  if (raw === undefined) return undefined
  const values = raw.split(',').map(part => Number(part.trim()))
  if (values.length !== 4 || !values.every(Number.isFinite)) return undefined
  return values as Bounds4
}

/**
 * Parses the helper's AX dump. Nesting is indentation and frames are inherited,
 * because AppKit omits `bounds` on text leaves whose nearest framed ancestor is
 * the group or window that positions them.
 */
export function parseAxNodes(tree: string): AxNode[] {
  const nodes: AxNode[] = []
  const stack: Array<{ depth: number; bounds?: Bounds4 }> = []
  for (const line of tree.split('\n')) {
    const match = line.match(LINE)
    if (match === null) continue
    const [, indent, index, role, rest = ''] = match
    const depth = Math.floor(indent!.length / 2)
    while (stack.length > 0 && stack.at(-1)!.depth >= depth) stack.pop()
    const inheritedBounds = stack.at(-1)?.bounds
    const bounds = frame(rest, 'bounds')
    const identifier = quoted(rest, 'identifier') ?? quoted(rest, 'id')
    const node: AxNode = {
      ...index === undefined ? {} : { index },
      role,
      title: rest.match(/^"([^"]*)"/u)?.[1] ?? '',
      value: rest.match(/(?:^|\s)=\s"([^"]*)"/u)?.[1] ?? quoted(rest, 'value') ?? null,
      ...identifier === undefined ? {} : { identifier },
      ...quoted(rest, 'description') === undefined ? {} : { description: quoted(rest, 'description')! },
      ...quoted(rest, 'placeholder') === undefined ? {} : { placeholder: quoted(rest, 'placeholder')! },
      ...quoted(rest, 'help') === undefined ? {} : { help: quoted(rest, 'help')! },
      actions: [...(rest.match(/actions=\[([^\]]+)\]/u)?.[1] ?? '').matchAll(/"([^"]+)"/gu)].map(entry => entry[1]!),
      ...bounds === undefined ? {} : { bounds },
      ...inheritedBounds === undefined ? {} : { inheritedBounds },
      hidden: flag(rest, 'hidden'),
      offscreen: flag(rest, 'offscreen') || flag(rest, 'minimized'),
      enabled: !/\bdisabled\b/u.test(rest) && !/\benabled=false\b/u.test(rest),
      focused: flag(rest, 'focused'),
      depth,
    }
    nodes.push(node)
    stack.push({ depth, bounds: bounds ?? inheritedBounds })
  }
  return nodes
}

/** Roles whose AX description is the control's own readable label (AppKit custom titles). */
const LABEL_ROLE = /^(?:AX)?(?:Button|MenuItem|CheckBox|RadioButton|PopUpButton|Tab|SegmentedControl|Link|Toggle)$/u
/** Roles that render a value/placeholder inside the control. */
const TEXT_ROLE = /^(?:AX)?(?:TextField|TextArea|ComboBox|SearchField)$/u
/** Container roles: their description is an accessibility note, never drawn text. */
const CONTAINER_ROLE = /^(?:AX)?(?:Group|ScrollArea|Window|Sheet|Table|Outline|List|SplitGroup|Toolbar|TabGroup|Grid|Document)$/u

/**
 * The text a sighted user can read on this node.
 *
 * - `title` and `value` are always visible content;
 * - `placeholder` is drawn inside an empty control and is the control's label
 *   for AX purposes, so it counts;
 * - `description` counts only when the node has no other text and its role is a
 *   labelled control: AppKit reports custom-drawn button titles there. A
 *   description on a container or scroll area is a screen-reader note (it is
 *   *not* painted on screen) and never satisfies an assertion.
 */
export function visibleTextOf(node: AxNode): string[] {
  const texts: string[] = []
  if (node.title !== '') texts.push(node.title)
  if (node.value !== null && node.value !== '') texts.push(node.value)
  if (node.placeholder !== undefined && node.placeholder !== '') texts.push(node.placeholder)
  if (node.description !== undefined && node.description !== '') {
    if (texts.length === 0 && !CONTAINER_ROLE.test(node.role)
      && (LABEL_ROLE.test(node.role) || TEXT_ROLE.test(node.role))) texts.push(node.description)
  }
  return texts
}

export interface Visibility {
  visible: boolean
  reason: 'ok' | 'no_geometry' | 'zero_size' | 'outside_window' | 'hidden' | 'offscreen'
  bounds?: Bounds4
  geometry: 'own' | 'inherited' | 'window' | 'none'
}

function intersects(bounds: Bounds4, window: WindowRect): boolean {
  const [x, y, width, height] = bounds
  return x + width > window.x && x < window.x + window.width
    && y + height > window.y && y < window.y + window.height
}

/**
 * Visibility for one node, in AX screen points.
 *
 * With a window frame the check is geometric: the effective frame (own, else the
 * nearest framed ancestor, else the window itself) must have a positive size and
 * intersect the window. Without one — a state the provider never produces, but
 * stub fixtures and older helpers do — only the structural flags are checked and
 * the result is reported as `no_geometry` so callers can see the difference.
 */
export function isVisible(node: AxNode, window: WindowRect | undefined): Visibility {
  if (node.hidden) return { visible: false, reason: 'hidden', ...boundsOf(node) }
  if (node.offscreen) return { visible: false, reason: 'offscreen', ...boundsOf(node) }
  if (window === undefined) {
    return { visible: true, reason: 'no_geometry', geometry: 'none' }
  }
  const own = node.bounds
  if (own !== undefined && (own[2] <= 0 || own[3] <= 0)) {
    return { visible: false, reason: 'zero_size', bounds: own, geometry: 'own' }
  }
  const inherited = own === undefined ? node.inheritedBounds : undefined
  if (inherited !== undefined && (inherited[2] <= 0 || inherited[3] <= 0)) {
    return { visible: false, reason: 'zero_size', bounds: inherited, geometry: 'inherited' }
  }
  const geometry: Visibility['geometry'] = own !== undefined ? 'own' : inherited !== undefined ? 'inherited' : 'window'
  const bounds = own ?? inherited ?? [window.x, window.y, window.width, window.height] as Bounds4
  if (!intersects(bounds, window)) {
    return { visible: false, reason: 'outside_window', bounds, geometry }
  }
  return { visible: true, reason: 'ok', bounds, geometry }
}

function boundsOf(node: AxNode): { bounds?: Bounds4; geometry: Visibility['geometry'] } {
  if (node.bounds !== undefined) return { bounds: node.bounds, geometry: 'own' }
  if (node.inheritedBounds !== undefined) return { bounds: node.inheritedBounds, geometry: 'inherited' }
  return { geometry: 'none' }
}

/** The accessible name used to match `input_value` / `checkbox` labels. */
export function nodeName(node: AxNode): string {
  return (node.placeholder || node.title || node.identifier || '').trim()
}

function nativeActions(role: string, declared: string[]): string[] {
  const actions = new Set<string>()
  if (declared.some(action => /^(?:AX)?Press$/u.test(action))) actions.add('click')
  if (declared.some(action => /^(?:AX)?Increment$/u.test(action))) actions.add('increment')
  if (declared.some(action => /^(?:AX)?Decrement$/u.test(action))) actions.add('decrement')
  if (/TextField|TextArea|TextView|SearchField|ComboBox/iu.test(role)) actions.add('type')
  if (/TextField|TextArea|TextView|SearchField|ComboBox|Document/iu.test(role)) actions.add('paste')
  if (/Button|CheckBox|RadioButton|MenuItem|PopUpButton/iu.test(role)) actions.add('click')
  return [...actions]
}

/** Maps the AX dump to the observation elements a decision model may target. */
export function parseAxElements(tree: string, window: any): ObservedElement[] {
  const elements: ObservedElement[] = []
  for (const node of parseAxNodes(tree)) {
    if (node.index === undefined) continue
    elements.push({
      id: node.index,
      role: node.role,
      name: nodeName(node),
      value: node.value,
      actions: nativeActions(node.role, node.actions),
      enabled: node.enabled,
      focused: node.focused,
      inputType: /SecureTextField/iu.test(node.role) ? 'password' : undefined,
      context: window?.title ?? '',
      ...node.bounds === undefined ? {} : { bounds: node.bounds },
      ...node.identifier === undefined ? {} : { identifier: node.identifier },
      declaredActions: node.actions,
    })
  }
  return elements
}

/** Visible text of the whole tree; kept for diagnostics and legacy callers. */
export function visibleAxText(tree: string, window?: WindowRect): string {
  return parseAxNodes(tree)
    .filter(node => isVisible(node, window).visible)
    .flatMap(node => visibleTextOf(node))
    .join('\n')
}

// ---------------------------------------------------------------------------
// Verification registry (no process-global mutable handler map)
// ---------------------------------------------------------------------------

export interface NativeVerificationCaller {
  call(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
}

export interface NativeVerificationWindow {
  windowId: number
  pid: number
  title: string
  bounds?: WindowRect
}

/**
 * Handler context. The window is fixed by the provider, so a handler cannot ask
 * for a different window or supply its own evidence; `evidence` is the read the
 * provider just performed for this assertion.
 */
export interface NativeVerificationContext {
  caller?: NativeVerificationCaller
  /** The window this run selected; not taken from the assertion. */
  window: NativeVerificationWindow
  /** Provider-selected call parameters (app handle, window id, details). */
  params: Readonly<Record<string, unknown>>
  evidence: AssertionEvidence[]
  signal: AbortSignal
}

export type NativeVerificationHandler =
  (args: Record<string, unknown>, context: NativeVerificationContext) => Promise<boolean>

export interface NativeVerificationRegistry {
  readonly names: readonly string[]
  has(name: string): boolean
  run(name: string, args: Record<string, unknown>, context: NativeVerificationContext): Promise<boolean>
}

const HANDLER_NAME = /^[a-z][a-z0-9_]{0,63}$/u

/**
 * Builds a frozen handler registry at construction time. Later code cannot add,
 * replace or remove a handler, so "which code evaluates a custom assertion" is a
 * deployment decision instead of a side effect of module import order.
 */
export function createVerificationRegistry(
  entries: ReadonlyArray<readonly [string, NativeVerificationHandler]>
    | Record<string, NativeVerificationHandler> = [],
): NativeVerificationRegistry {
  const pairs: ReadonlyArray<readonly [string, NativeVerificationHandler]> =
    Array.isArray(entries) ? entries : Object.entries(entries)
  const handlers = new Map<string, NativeVerificationHandler>()
  for (const [name, handler] of pairs) {
    if (!HANDLER_NAME.test(name)) throw new Error(`invalid native verification handler name: ${name}`)
    if (handlers.has(name)) throw new Error(`duplicate native verification handler: ${name}`)
    if (typeof handler !== 'function') throw new Error(`native verification handler is not a function: ${name}`)
    handlers.set(name, handler)
  }
  const names = Object.freeze([...handlers.keys()])
  return Object.freeze({
    names,
    has: (name: string) => handlers.has(name),
    run: async (name: string, args: Record<string, unknown>, context: NativeVerificationContext) => {
      const handler = handlers.get(name)
      if (handler === undefined) throw new Error(`Unknown native verification handler: ${name}`)
      return await handler(args, context) === true
    },
  })
}

/** No custom handlers by default: a `custom` assertion then fails closed. */
export const EMPTY_VERIFICATION_REGISTRY: NativeVerificationRegistry = createVerificationRegistry([])

// ---------------------------------------------------------------------------
// Assertion evaluation
// ---------------------------------------------------------------------------

export interface ElementEvidence {
  index?: string
  identifier?: string
  role: string
  visible: boolean
  reason: Visibility['reason']
  geometry: Visibility['geometry']
  bounds?: Bounds4
}

export interface AssertionEvidence {
  type: string
  name?: string
  ok: boolean
  reason: string
  element?: ElementEvidence
}

export interface NativeVerificationEvidence {
  pid: number
  windowId: number | null
  /** `window`: frames were available; `structural`: the state carried no frames. */
  geometry: 'window' | 'structural'
  assertions: AssertionEvidence[]
}

export interface NativeVerificationResult {
  ok: boolean
  reason: string
  evidence: NativeVerificationEvidence
}

export interface NativeVerificationInput {
  tree: string
  pid: number
  windowId: number | null
  window: { windowId: number; title?: string; bounds?: WindowRect; isOnScreen?: boolean } | undefined
  assertions: Verification[]
  registry?: NativeVerificationRegistry
  caller?: NativeVerificationCaller
  signal: AbortSignal
  /** Arguments per custom assertion name; handed to the registered handler only. */
  customArgs?: Record<string, Record<string, unknown>>
  /** Provider-selected call parameters, passed through to custom handlers. */
  params?: Record<string, unknown>
}

function elementEvidence(node: AxNode, visibility: Visibility): ElementEvidence {
  return {
    ...node.index === undefined ? {} : { index: node.index },
    ...node.identifier === undefined ? {} : { identifier: node.identifier },
    role: node.role,
    visible: visibility.visible,
    reason: visibility.reason,
    geometry: visibility.geometry,
    ...visibility.bounds === undefined ? {} : { bounds: visibility.bounds },
  }
}

/** The only address a native window has: `app://<pid>/<windowId>`. */
export function windowAddress(pid: number, windowId: number | null): string {
  return `app://${pid}/${windowId ?? ''}`
}

const CHECKED = new Set(['1', 'true', 'checked', 'on', 'yes'])

function checkedValue(node: AxNode): boolean {
  const raw = node.value
  if (raw === null) return false
  return CHECKED.has(raw.trim().toLowerCase())
}

/**
 * Evaluates every assertion against one fresh AX read.
 *
 * The result is `ok` only when *all* assertions pass. An assertion type this
 * provider cannot evaluate, a handler that is not registered, a throwing
 * handler, and missing window evidence all fail closed instead of being skipped.
 */
export async function evaluateNativeVerification(input: NativeVerificationInput): Promise<NativeVerificationResult> {
  const assertions: AssertionEvidence[] = []
  const nodes = parseAxNodes(input.tree)
  const geometry: 'window' | 'structural' = input.window?.bounds === undefined ? 'structural' : 'window'
  const evidence: NativeVerificationEvidence = { pid: input.pid, windowId: input.windowId, geometry, assertions }
  if (input.windowId === null) {
    // Without a window identity there is nothing to bind the evidence to.
    return { ok: false, reason: 'window_evidence_missing', evidence }
  }
  // A state that omits the window entry still identifies the window by id; only
  // its frame is unavailable, which downgrades the check to structural.
  const liveWindow = input.window ?? { windowId: input.windowId }
  const windowRef: NativeVerificationWindow = {
    windowId: input.windowId,
    pid: input.pid,
    title: liveWindow.title ?? '',
    ...liveWindow.bounds === undefined ? {} : { bounds: liveWindow.bounds },
  }
  if (liveWindow.isOnScreen === false) {
    assertions.push({ type: 'window', ok: false, reason: 'window_not_on_screen' })
    return { ok: false, reason: 'window_not_on_screen', evidence }
  }

  const candidates = nodes.map(node => ({ node, visibility: isVisible(node, liveWindow.bounds) }))
  const registry = input.registry ?? EMPTY_VERIFICATION_REGISTRY

  for (const assertion of input.assertions) {
    if (assertion.type === 'text_visible') {
      const match = candidates.find(candidate => candidate.visibility.visible
        && visibleTextOf(candidate.node).some(text => text.includes(assertion.text)))
      assertions.push(match === undefined
        ? { type: 'text_visible', ok: false, reason: 'text_not_visible' }
        : { type: 'text_visible', ok: true, reason: 'text_visible', element: elementEvidence(match.node, match.visibility) })
      continue
    }
    if (assertion.type === 'url_contains') {
      // Native applications expose no URL. Only the provider's own window
      // address is a real target for this assertion, so a substring such as
      // "app" or the bare pid can never make it trivially true.
      const ok = assertion.value === windowAddress(input.pid, input.windowId)
      assertions.push({ type: 'url_contains', ok, reason: ok ? 'window_address' : 'not_a_window_address' })
      continue
    }
    if (assertion.type === 'input_value' || assertion.type === 'checkbox') {
      const labelled = candidates.filter(candidate =>
        nodeName(candidate.node) === assertion.label || candidate.node.identifier === assertion.label)
      const visible = labelled.find(candidate => candidate.visibility.visible)
      if (visible === undefined) {
        assertions.push({
          type: assertion.type, ok: false,
          reason: labelled.length === 0 ? 'element_not_found' : 'element_not_visible',
          ...labelled.length === 0 ? {} : { element: elementEvidence(labelled[0]!.node, labelled[0]!.visibility) },
        })
        continue
      }
      if (assertion.type === 'input_value') {
        const value = visible.node.value
        assertions.push(value === assertion.value
          ? { type: 'input_value', ok: true, reason: 'value_matches', element: elementEvidence(visible.node, visible.visibility) }
          : {
              type: 'input_value', ok: false,
              reason: value === null ? 'value_missing' : 'value_mismatch',
              element: elementEvidence(visible.node, visible.visibility),
            })
        continue
      }
      const ok = checkedValue(visible.node) === assertion.checked
      assertions.push({
        type: 'checkbox', ok, reason: ok ? 'checked_matches' : 'checked_mismatch',
        element: elementEvidence(visible.node, visible.visibility),
      })
      continue
    }
    if (assertion.type === 'custom') {
      // Only a handler registered at construction may answer, and only with the
      // evidence the provider just read for the fixed window.
      let ok = false
      let reason = 'custom_handler_unavailable'
      if (registry.has(assertion.name)) {
        try {
          ok = await registry.run(assertion.name, input.customArgs?.[assertion.name] ?? {}, {
            ...input.caller === undefined ? {} : { caller: input.caller },
            window: windowRef,
            params: Object.freeze({ ...input.params ?? {} }),
            evidence: assertions,
            signal: input.signal,
          })
          reason = ok ? 'custom_handler_passed' : 'custom_handler_failed'
        } catch {
          ok = false
          reason = 'custom_handler_failed'
        }
      }
      assertions.push({ type: 'custom', name: assertion.name, ok, reason })
      continue
    }
    // A verification type this provider does not implement is never satisfied.
    assertions.push({ type: String((assertion as { type?: unknown }).type), ok: false, reason: 'unsupported_assertion' })
  }

  const failed = assertions.find(assertion => !assertion.ok)
  return { ok: failed === undefined, reason: failed?.reason ?? 'verified', evidence }
}
