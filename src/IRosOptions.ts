import type { TLSSocketOptions } from 'node:tls'

/**
 * Options for creating a new RouterOSAPI connection
 *
 * @type {IRosOptions}
 */
export interface IRosOptions {
  host: string
  user?: string
  password?: string
  port?: number
  timeout?: number
  tls?: TLSSocketOptions | null
  keepalive?: boolean
}
