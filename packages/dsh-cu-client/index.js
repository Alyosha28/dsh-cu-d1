/**
 * Host half of the client package. It carries no behavior: the package exists
 * so the DSH client-module scanner finds a Loader entry that declares
 * `dsh.client` and serves its browser bundle at /plugins/<entry>/client.js.
 */
export const name = 'dsh-cu-client'

export function apply() {}
