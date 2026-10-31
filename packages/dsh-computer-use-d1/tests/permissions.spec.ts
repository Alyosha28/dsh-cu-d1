import { expect, it } from 'vitest'
import { permissionSettingsUrl, readPermissions } from '../src/permissions.ts'

it('reports both privacy states without ever prompting', { timeout: 120000 }, async () => {
  const state = await readPermissions()
  expect(typeof state.accessibility).toBe('boolean')
  expect(typeof state.screenRecording).toBe('boolean')
  // Preflight must not open a macOS dialog: prompting is a separate, explicit call.
  expect(state.prompted).toBe(false)
})

it('links to the exact System Settings pane for each permission', () => {
  expect(permissionSettingsUrl('accessibility'))
    .toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
  expect(permissionSettingsUrl('screenRecording'))
    .toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
})
