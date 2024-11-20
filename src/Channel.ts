import { EventEmitter } from 'node:events'
import { Connector } from './Connector'
import { RosException } from './RosException'
import debug from 'debug'
import type { IRosGenericResponse } from './IRosGenericResponse'
import { randomBytes } from 'node:crypto'

const info = debug('routeros-api:channel:info')
const error = debug('routeros-api:channel:error')

/**
 * Channel class is responsible for generating
 * ids for the channels and writing over
 * the ids generated, while listening for
 * their responses
 */
export class Channel extends EventEmitter {
  /**
   * Id of the channel
   */
  public readonly id: string

  /**
   * Data received related to the channel
   */
  private data: any[] = []

  /**
   * If received a trap instead of a positive response
   */
  private trapped = false

  /**
   * If is streaming content
   */
  private streaming = false

  /**
   * Initializes a new Channel instance, generating a unique identifier
   * and setting up the connector for communicating with the routerboard.
   * Listens for unknown events to handle them appropriately.
   *
   * @param {Connector} connector - The connector instance to be used for communication.
   */
  constructor(public readonly connector: Connector) {
    super()
    this.id = randomBytes(16).toString('hex')
    this.once('unknown', this.onUnknown.bind(this))
  }

  /**
   * Writes the provided command parameters to the channel, appending a unique tag.
   * The function can handle both streaming and non-streaming scenarios and returns
   * a promise that resolves when the operation is complete.
   *
   * @param {string[]} params - The command parameters to send to the routerboard.
   * @param {boolean} [isStream=false] - Indicates if the channel is in streaming mode.
   * @param {boolean} [returnPromise=true] - If true, returns a promise that resolves
   *        when the operation is done or rejects if a trap is encountered.
   * @returns {Promise<IRosGenericResponse[]>} - A promise that resolves with the response data
   *          or rejects with an error message if a trap is received.
   */
  public write(
    params: string[],
    isStream = false,
    returnPromise = true,
  ): Promise<IRosGenericResponse[]> {
    this.streaming = isStream
    params.push(`.tag=${this.id}`)

    this.readAndWrite(params)

    if (returnPromise) {
      return new Promise((resolve, reject) => {
        this.once('done', resolve)
        this.once('trap', (data) => reject(new Error(data.message)))
      })
    }

    return Promise.resolve([])
  }

  /**
   * Closes the channel, optionally forcing closure and removing all listeners.
   * Emits a "close" event and stops reading for the current channel tag.
   *
   * @param {boolean} [force=false] - If true, all listeners are removed even if streaming.
   */
  public close(force = false): void {
    this.emit('close')
    if (!this.streaming || force) {
      this.removeAllListeners()
    }
    this.connector.stopRead(this.id)
  }

  /**
   * Initiates a read operation for the current channel's tag and writes
   * the provided parameters to the connector. The read operation sets up
   * a callback to process packets received for the channel, while the
   * write operation sends the parameters over the connection.
   *
   * @param {string[]} params - The parameters to be written to the connector.
   */
  private readAndWrite(params: string[]): void {
    this.connector.read(this.id, (packet: string[]) =>
      this.processPacket(packet),
    )
    this.connector.write(params)
  }

  /**
   * Process a packet received from the connector, emitting "data" events if the packet is not a
   * stream packet and the channel is not streaming. If the packet is a stream packet, emits a
   * "stream" event. If the packet is a "!done" packet, emits a "done" event with the collected data
   * and closes the channel. If the packet is a "!trap" packet, sets the channel to a "trapped"
   * state and emits a "trap" event. If the packet is any other type of packet, emits an "unknown"
   * event and closes the channel.
   *
   * @private
   * @param {string[]} packet - The packet to be processed.
   */
  private processPacket(packet: string[]): void {
    const reply = packet[0]
    const parsed = this.parsePacket(packet.slice(1))

    if (reply === '!trap') {
      this.trapped = true
      this.emit('trap', parsed)
      return
    }

    if (packet.length > 1 && !this.streaming) this.emit('data', parsed)

    switch (reply) {
      case '!re':
        if (this.streaming) this.emit('stream', parsed)
        break
      case '!done':
        if (!this.trapped) this.emit('done', this.data)
        this.close()
        break
      default:
        this.emit('unknown', reply)
        this.close()
        break
    }
  }

  /**
   * Takes a packet and parses it into a key-value object.
   * It works by splitting each line by "=" and using the first part as the key
   * and the second part as the value. It ignores empty lines and lines with no
   * "=" character.
   *
   * @private
   * @param {string[]} packet - The packet to be parsed.
   * @returns {Record<string, string>} - The parsed packet as a key-value object.
   */
  private parsePacket(packet: string[]): Record<string, any> {
    const obj: Record<string, any> = {}
    for (const line of packet) {
      const linePair = line.split('=')
      linePair.shift() // remove empty index
      const key = linePair.shift()
      if (key) obj[key] = linePair.join('=')
    }
    info('Parsed line, got %o as result', obj)
    return obj
  }

  /**
   * Emits an error if the channel receives an unknown reply type.
   * @private
   * @param {string} reply - The reply type received from the routerboard.
   */
  private onUnknown(reply: string): void {
    throw new RosException('UNKNOWNREPLY', { reply })
  }
}
