import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { compileSwiftHelper } from '@alyosha28/dsh-cu-core/helper-cache'

const run = promisify(execFile)

export type PermissionKind = 'accessibility' | 'screenRecording'

export interface PermissionState {
  accessibility: boolean
  screenRecording: boolean
  /** True when this call opened a macOS privacy dialog. */
  prompted: boolean
}

const SETTINGS: Record<PermissionKind, string> = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screenRecording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
}

/** Deep link to the exact System Settings pane that grants this permission. */
export function permissionSettingsUrl(kind: PermissionKind): string {
  return SETTINGS[kind]
}

let helper: Promise<string> | undefined

function helperBinary(): Promise<string> {
  helper ??= compileSwiftHelper(
    [fileURLToPath(new URL('../native/PermissionPrompt.swift', import.meta.url))],
    'PermissionPrompt',
  )
  return helper
}

async function invoke(mode: 'status' | 'accessibility' | 'screen' | 'both'): Promise<PermissionState> {
  if (process.platform !== 'darwin') {
    return { accessibility: false, screenRecording: false, prompted: false }
  }
  const binary = await helperBinary()
  const { stdout } = await run(binary, mode === 'status' ? [] : [mode], { timeout: 60000 })
  const parsed = JSON.parse(stdout) as Partial<PermissionState>
  return {
    accessibility: parsed.accessibility === true,
    screenRecording: parsed.screenRecording === true,
    prompted: parsed.prompted === true,
  }
}

/** Reads current state without ever showing a dialog. */
export async function readPermissions(): Promise<PermissionState> {
  return invoke('status')
}

/**
 * Shows the macOS privacy dialog for the requested permission.
 *
 * macOS only shows it once per granting decision, and the grant takes effect
 * after a restart of the host application; the returned state is the state
 * before that restart.
 */
export async function requestPermission(kind: PermissionKind | 'both'): Promise<PermissionState> {
  if (kind === 'both') return invoke('both')
  return invoke(kind === 'accessibility' ? 'accessibility' : 'screen')
}

/** Opens the matching System Settings pane. */
export async function openPermissionSettings(kind: PermissionKind): Promise<void> {
  if (process.platform !== 'darwin') return
  await run('open', [permissionSettingsUrl(kind)]).catch(() => undefined)
}
