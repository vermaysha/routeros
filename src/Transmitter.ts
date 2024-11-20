import { Socket } from 'node:net'
import iconv from 'iconv-lite'
import debug from 'debug'

const info = debug('routeros-api:connector:transmitter:info')
const error = debug('routeros-api:connector:transmitter:error')

/**
 * Class responsible for transmitting data over the
 * socket to the routerboard
 */
export class Transmitter {
  /**
   * The socket which connects to the routerboard
   */
  private socket: Socket

  /**
   * Pool of data to be sent after the socket connects
   */
  private pool: (string | Uint8Array)[] = []

  /**
   * Constructor
   *
   * @param socket
   */
  constructor(socket: Socket) {
    this.socket = socket
  }

  /**
   * Write data over the socket, if it not writable yet,
   * save over the pool to be ran after
   *
   * @param {string} data
   */
  public write(data: string | null): void {
    const encodedData = this.encodeString(data)
    if (!this.socket.writable || this.pool.length > 0) {
      info('Socket not writable, saving %o in the pool', data)
      this.pool.push(encodedData)
    } else {
      info('Writing command %s over the socket', data)
      this.socket.write(encodedData)
    }
  }

  /**
   * Writes all data stored in the pool
   */
  public runPool(): void {
    info('Running stacked command pool')
    const datas: (string | Uint8Array)[] = this.pool.splice(0, this.pool.length)
    datas.forEach((data) => this.socket.write(data))
  }

  /**
   * Encode the string data that will
   * be sent over to the routerboard.
   *
   * It's encoded in win1252 so any accentuation on foreign languages
   * are displayed correctly when opened with winbox.
   *
   * Credits for George Joseph: https://github.com/gtjoseph
   * and for Brandon Myers: https://github.com/Trakkasure
   *
   * @param {string} str
   */
  private encodeString(str: string | null): Buffer {
    if (str === null) return Buffer.from([0x00])

    const encoded = iconv.encode(str, 'win1252')
    const len = encoded.length

    const data = Buffer.allocUnsafe(len + 1)
    data[0] = len
    encoded.copy(data, 1)

    return data
  }
}
