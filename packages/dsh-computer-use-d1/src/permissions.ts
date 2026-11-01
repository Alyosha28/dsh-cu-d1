import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { compileSwiftHelper } from '@albaincompleta/dsh-cu-core/helper-cache'

const run = promisify(execFile)

export type PermissionKind = 'accessibility' | 'screenRecording'

/**
 * What this module can actually prove about the *host application's* privacy
 * grant.
 *
 * `granted` is only reported when the answer is known to describe the host. The
 * probe below runs as a freshly compiled binary in a temporary directory; macOS
 * attributes TCC to that binary's own identity, so its `AXIsProcessTrusted()`
 * says nothing about the application the user is running. Everything it reports
 * is therefore `unknown` for the host, and the authoritative source stays the
 * Computer Use provider's own `getCapabilities` call.
 */
export type PermissionVerdict = 'granted' | 'denied' | 'unknown'

export interface PermissionState {
  accessibility: PermissionVerdict
  screenRecording: PermissionVerdict
  /** True when this call asked macOS to show a privacy dialog. */
  prompted: boolean
  /** Which identity answered: the temporary helper, or nothing at all. */
  source: 'helper' | 'unsupported' | 'unavailable'
  /** Raw self-report of the temporary helper. Diagnostics only, never authorization. */
  helperSelfCheck: { accessibility: boolean; screenRecording: boolean } | null
  /** One line explaining how to obtain an authoritative answer. */
  detail: string
}

const SETTINGS: Record<PermissionKind, string> = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screenRecording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
}

/** Deep link to the exact System Settings pane that grants this permission. */
export function permissionSettingsUrl(kind: PermissionKind): string {
  return SETTINGS[kind]
}

const AUTHORITATIVE = 'The host application\'s state is reported by the Computer Use provider getCapabilities call; '
  + 'this probe cannot see it because the temporary helper has its own TCC identity.'

let helper: Promise<string> | undefined

function helperBinary(): Promise<string> {
  helper ??= compileSwiftHelper(
    [fileURLToPath(new URL('../native/PermissionPrompt.swift', import.meta.url))],
    'PermissionPrompt',
  )
  return helper
}

interface ProbeResult {
  accessibility: boolean
  screenRecording: boolean
  prompted: boolean
}

async function probe(mode: 'status' | 'accessibility' | 'screen' | 'both'): Promise<ProbeResult> {
  const binary = await helperBinary()
  const { stdout } = await run(binary, mode === 'status' ? [] : [mode], { timeout: 60000 })
  const parsed = JSON.parse(stdout) as Partial<ProbeResult>
  return {
    accessibility: parsed.accessibility === true,
    screenRecording: parsed.screenRecording === true,
    prompted: parsed.prompted === true,
  }
}

/**
 * Reads the probe's own view of the machine.
 *
 * This is useful for diagnostics ("is Accessibility trusted for *something* on
 * this box?") and must never be returned as the host application's permission.
 */
export async function readPermissionSelfCheck(): Promise<ProbeResult | undefined> {
  if (process.platform !== 'darwin') return undefined
  try {
    return await probe('status')
  } catch {
    return undefined
  }
}

function stateFrom(selfCheck: ProbeResult | null, prompted: boolean, source: PermissionState['source'], detail: string): PermissionState {
  return {
    accessibility: 'unknown',
    screenRecording: 'unknown',
    prompted,
    source,
    helperSelfCheck: selfCheck,
    detail,
  }
}

/** Reads current state without ever showing a dialog. */
export async function readPermissions(): Promise<PermissionState> {
  if (process.platform !== 'darwin') {
    return stateFrom(null, false, 'unsupported', 'Computer Use permissions are macOS-only.')
  }
  try {
    const selfCheck = await probe('status')
    return stateFrom(selfCheck, false, 'helper', AUTHORITATIVE)
  } catch {
    return stateFrom(null, false, 'unavailable', 'The permission probe binary could not be compiled or executed.')
  }
}

/**
 * Shows the macOS privacy dialog for the requested permission.
 *
 * macOS shows it once per granting decision and applies it to the binary that
 * asked, which is the temporary probe — not the host application. The dialog is
 * still useful as a signpost; the returned verdicts stay `unknown`.
 */
export async function requestPermission(kind: PermissionKind | 'both'): Promise<PermissionState> {
  if (process.platform !== 'darwin') {
    return stateFrom(null, false, 'unsupported', 'Computer Use permissions are macOS-only.')
  }
  try {
    const selfCheck = await probe(kind === 'both' ? 'both' : kind === 'accessibility' ? 'accessibility' : 'screen')
    return stateFrom(selfCheck, selfCheck.prompted, 'helper', AUTHORITATIVE)
  } catch {
    return stateFrom(null, false, 'unavailable', 'The permission probe binary could not be compiled or executed.')
  }
}

/** Opens the matching System Settings pane. */
export async function openPermissionSettings(kind: PermissionKind): Promise<void> {
  if (process.platform !== 'darwin') return
  await run('open', [permissionSettingsUrl(kind)]).catch(() => undefined)
}
