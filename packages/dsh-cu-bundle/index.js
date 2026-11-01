/**
 * The bundle is a patch layer, not a runtime plugin: its cordis.patch.yml
 * inserts the D1 provider entries into a DSH profile. This module exists so the
 * package can also be imported without special-casing.
 *
 * Plain JavaScript: this file ships as-is, so it must contain no TypeScript
 * syntax. A `: void` return annotation here makes `import()` of the package fail
 * with `SyntaxError: Unexpected token ':'` (found by the doctor's import check).
 */
export const name = 'dsh-cu-bundle'

export function apply() {}
