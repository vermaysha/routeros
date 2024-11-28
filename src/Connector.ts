import { EventEmitter } from 'node:events'
import { Socket } from 'node:net'
import { TLSSocketOptions, TLSSocket } from 'node:tls'
import { Receiver } from './Receiver'
import { Transmitter } from './Transmitter'
import { RosException } from './RosException'
import debug from 'debug'
import { IRosOptions } from './IRosOptions'

const info = debug('routeros-api:connector:connector:info')
const error = debug('routeros-api:connector:connector:error')

/**
 * Connector class responsible for communicating with
 * the routeros via api, sending and receiving buffers.
 *
 * The main focus of this class is to be able to
 * construct and destruct dinamically by the RouterOSAPI class
 * when needed, so the authentication parameters don't
 * need to be changed every time we need to reconnect.
 */
export class Connector extends EventEmitter {
  /**
   * The host or address of where to connect to
   */
  public host: string

  /**
   * The port of the API
   */
  public port = 8728

  /**
   * The timeout in seconds of the connection
   */
  public timeout = 10

  /**
   * The socket of the connection
   */
  private socket?: Socket

  /**
   * The transmitter object to write commands
   */
  private transmitter?: Transmitter

  /**
   * The receiver object to read commands
   */
  private receiver?: Receiver

  /**
   * Connected status
   */
  private connected = false

  /**
   * Connecting status
   */
  private connecting = false

  /**
   * Closing status
   */
  private closing = false

  /**
   * TLS data
   */
  private tls: TLSSocketOptions | null = null

  /**
   * Creates a new Connector object with the given options
   *
   * @param {IRosOptions} options - connection options
   * @param {string} options.host - The host to connect to
   * @param {number} [options.port=8728] - The port of the API
   * @param {number} [options.timeout=10] - The timeout of the connection
   * @param {TLSSocketOptions} [options.tls=null] - TLS Options to use, if any
   */
  constructor(options: IRosOptions) {
    super()

    this.host = options.host
    this.timeout = options.timeout ?? 0
    this.port = options.port ?? 8728

    if (typeof options.tls === 'boolean' && options.tls) options.tls = {}
    if (typeof options.tls === 'object' && options.tls !== null) {
      if (!options.port) this.port = 8729
      this.tls = options.tls
    }
  }

  /**
   * Establishes a connection to the routerboard. If the connection is already
   * established or a connection is in progress, the function does nothing.
   *
   * @returns {this} - The current Connector instance
   */
  public connect(): this {
    if (!this.connected && !this.connecting) {
      this.connecting = true
      const socket = new Socket()
      this.transmitter = new Transmitter(socket)
      this.receiver = new Receiver(socket)
      this.socket = this.tls ? new TLSSocket(socket, this.tls) : socket
      this.socket.once('connect', this.onConnect.bind(this))
      this.socket.once('end', this.onEnd.bind(this))
      this.socket.once('timeout', this.onTimeout.bind(this))
      this.socket.once('fatal', this.onEnd.bind(this))
      this.socket.on('error', this.onError.bind(this))
      this.socket.on('data', this.onData.bind(this))
      info(
        'Trying to connect to %s on port %s with timeout %s',
        this.host,
        this.port,
        this.timeout,
      )
      if (this.timeout > 0) {
        this.socket.setTimeout(this.timeout * 1000)
      } else {
        this.socket.setTimeout(0)
      }
      this.socket.setKeepAlive(true)

      this.socket.connect(this.port, this.host)
    }
    return this
  }

  /**
   * Writes the provided command parameters to the connector, appending a newline
   * after each command and at the end of the list.
   *
   * @param {string[]} data - The command parameters to send to the routerboard.
   * @returns {this} - The current Connector instance
   */
  public write(data: string[]): Connector {
    for (const line of data) {
      this.transmitter?.write(line)
    }
    this.transmitter?.write(null)
    return this
  }

  /**
   * Register a tag to receive data
   *
   * @param tag - The tag to register
   * @param callback - The callback function to handle the received packet
   */
  public read(tag: string, callback: (packet: string[]) => void): void {
    this.receiver?.read(tag, callback)
  }

  /**
   * Unregister a tag, so it no longer waits for data
   * @param tag - The tag to unregister
   */
  public stopRead(tag: string): void {
    this.receiver?.stop(tag)
  }

  /**
   * Start closing the connection
   * Ensures the connection is properly closed
   */
  public close(): void {
    if (!this.closing) {
      this.closing = true
      this.socket?.end()
    }
  }

  /**
   * Destroy the socket, preventing any further data exchange.
   * This method also removes all event listeners.
   */
  public destroy(): void {
    this.socket?.destroy()
    this.socket?.end()
    this.removeAllListeners()
  }

  /**
   * Socket connection event listener.
   * After the connection is stablished,
   * ask the transmitter to run any
   * command stored over the pool
   *
   * @returns {(this: Connector) => void}
   */
  private onConnect(): void {
    this.connecting = false
    this.connected = true
    info('Connected on %s', this.host)
    this.transmitter?.runPool()
    this.emit('connected', this)
  }

  /**
   * Socket end event listener.
   * Emits a "close" event and destroys the socket,
   * ensuring that the connection is properly terminated.
   */
  private onEnd(): void {
    this.emit('close', this)
    this.destroy()
  }

  /**
   * Socket error event listener.
   * Emmits the error while trying to connect and
   * destroys the socket.
   *
   * @returns {function}
   */
  private onError(err: any): void {
    const exception = new RosException(err.errno, err)
    console.error(exception, err)
    error(
      'Problem while trying to connect to %s. Error: %s',
      this.host,
      exception,
    )
    this.emit('error', exception, this)
    this.destroy()
  }

  /**
   * Socket timeout event listener
   * Emmits timeout error and destroys the socket
   *
   * @returns {function}
   */
  private onTimeout(): void {
    this.emit(
      'timeout',
      new RosException('SOCKTMOUT', { seconds: this.timeout }),
      this,
    )
    this.destroy()
  }

  /**
   * Socket data event listener
   * Receives the data and sends it to processing
   *
   * @returns {function}
   */
  private onData(data: Buffer): void {
    info('Got data from the socket, will process it')
    this.receiver?.processRawData(data)
  }
}
