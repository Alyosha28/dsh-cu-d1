/**
 * The bundle is a patch layer, not a runtime plugin: its cordis.patch.yml
 * inserts the D1 provider entries into a DSH profile. This module exists so the
 * package can also be imported without special-casing.
 */
export const name = 'dsh-cu-bundle'

export function apply(): void {}
