import { expect, it } from 'vitest'
import { permissionSettingsUrl, readPermissions, readPermissionSelfCheck } from '../src/permissions.ts'

it('never reports a grant that belongs to the temporary probe', { timeout: 120000 }, async () => {
  const state = await readPermissions()
  // The probe runs as a freshly compiled binary in a temp directory; macOS
  // attributes TCC to that binary, so its answer cannot authorize the host.
  expect(['helper', 'unavailable', 'unsupported']).toContain(state.source)
  expect(state.accessibility).toBe('unknown')
  expect(state.screenRecording).toBe('unknown')
  expect(state.detail).toMatch(/host application/u)
  // Preflight must not open a macOS dialog: prompting is a separate, explicit call.
  expect(state.prompted).toBe(false)
  if (state.helperSelfCheck !== null) {
    expect(typeof state.helperSelfCheck.accessibility).toBe('boolean')
    expect(typeof state.helperSelfCheck.screenRecording).toBe('boolean')
  }
})

it('exposes the probe self-check separately from the host verdict', { timeout: 120000 }, async () => {
  const selfCheck = await readPermissionSelfCheck()
  if (selfCheck !== undefined) {
    expect(typeof selfCheck.accessibility).toBe('boolean')
    expect(typeof selfCheck.screenRecording).toBe('boolean')
  }
})

it('links to the exact System Settings pane for each permission', () => {
  expect(permissionSettingsUrl('accessibility'))
    .toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
  expect(permissionSettingsUrl('screenRecording'))
    .toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
})
