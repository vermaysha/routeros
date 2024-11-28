import type { TLSSocketOptions } from 'node:tls'
import { Connector } from './Connector'
import { Channel } from './Channel'
import { RosException } from './RosException'
import type { IRosOptions } from './IRosOptions'
import { RStream, RStreamCallback } from './RStream'
import crypto from 'node:crypto'
import debug from 'debug'
import { clearTimeout } from 'node:timers'
import { EventEmitter } from 'node:events'
import type { IRosGenericResponse } from './IRosGenericResponse'

const info = debug('routeros-api:api:info')
const error = debug('routeros-api:api:error')

/**
 * Creates a connection object with the credentials provided
 */
export class RouterOSAPI extends EventEmitter {
  /**
   * Host to connect
   */
  public host: string

  /**
   * Username to use
   */
  public user: string

  /**
   * Password of the username
   */
  public password: string

  /**
   * Port of the API
   */
  public port: number

  /**
   * Timeout of the connection
   */
  public timeout: number

  /**
   * TLS Options to use, if any
   */
  public tls: TLSSocketOptions | null = null

  /**
   * Connected flag
   */
  public connected = false

  /**
   * Connecting flag
   */
  public connecting = false

  /**
   * Closing flag
   */
  public closing = false

  /**
   * Keep connection alive
   */
  public keepalive = false

  /**
   * The connector which will be used
   */
  private connector: Connector | null = null

  /**
   * The function timeout that will keep the connection alive
   */
  private keptaliveby: ReturnType<typeof setTimeout> | null = null

  /**
   * Counter for channels open
   */
  private channelsOpen = 0

  /**
   * Flag if the connection was held by the keepalive parameter
   * or keepaliveBy function
   */
  private holdingConnectionWithKeepalive = false

  /**
   * Store the timeout when holding the connection
   * when waiting for a channel response
   */
  private connectionHoldInterval: ReturnType<typeof setTimeout> | null = null

  /**
   * List of streams registered
   * for handling continuous data
   * from the routeros
   *
   * @type {RStream[]}
   */
  private registeredStreams: RStream[] = []

  /**
   * Creates a new RouterOSAPI connection object with the given options
   *
   * @param {IRosOptions} options - connection options
   * @param {string} options.host - The host to connect to
   * @param {string} [options.user='admin'] - The username to use
   * @param {string} [options.password=''] - The password of the username
   * @param {number} [options.port=8728] - The port of the API
   * @param {number} [options.timeout=10] - The timeout of the connection
   * @param {TLSSocketOptions} [options.tls=null] - TLS Options to use, if any
   * @param {boolean} [options.keepalive=false] - Keep connection alive
   */
  constructor(options: IRosOptions) {
    super()
    this.host = options.host
    this.user = options.user ?? 'admin'
    this.password = options.password ?? ''
    this.port = options.port ?? 8728
    this.timeout = options.timeout ?? 10
    this.tls = options.tls ?? null
    this.keepalive = options.keepalive ?? false

    info('Created new RouterOSAPI instance with options: %o', options)
  }

  /**
   * Connect to the routerboard
   *
   * @returns {Promise<RouterOSAPI>} - The current RouterOSAPI instance
   */
  public connect(): Promise<RouterOSAPI> {
    if (this.connecting) return Promise.reject('ALRDYCONNECTING')
    if (this.connected) return Promise.resolve(this)

    info('Connecting on %s', this.host)

    this.connecting = true
    this.connected = false

    this.connector = new Connector({
      host: this.host,
      port: this.port,
      timeout: this.timeout,
      tls: this.tls,
    })

    return new Promise((resolve, reject) => {
      /**
       * Socket end event listener.
       * Terminates the connection after
       * the socket is released
       * @param {Error} [e] - The error that caused the connection to close
       */
      const endListener = (e?: Error) => {
        this.stopAllStreams()
        this.connected = false
        if (e) reject(e)
      }
      this.connector?.once('error', endListener)
      this.connector?.once('timeout', endListener)
      this.connector?.once('close', () => {
        this.emit('close')
        endListener()
      })
      this.connector?.once('connected', () => {
        this.login()
          .then(() => {
            this.connecting = false
            this.connected = true
            this.connector?.removeListener('error', endListener)
            this.connector?.removeListener('timeout', endListener)

            /**
             * Error listener for the connected state.
             * Resets the connection and connecting flags
             * and emits an "error" event.
             * @param {Error} e - The error that caused the connection to fail
             */
            const connectedErrorListener = (e: Error) => {
              this.connected = false
              this.connecting = false
              this.emit('error', e)
            }

            this.connector?.once('error', connectedErrorListener)
            this.connector?.once('timeout', connectedErrorListener)

            if (this.keepalive) this.keepaliveBy('#')

            info('Logged in on %s', this.host)

            resolve(this)
          })
          .catch((e: RosException) => {
            this.connecting = false
            this.connected = false
            reject(e)
          })
      })

      this.connector?.connect()
    })
  }

  /**
   * Sends the provided command(s) to the routerboard via a new channel.
   * Opens a new channel for communication, writes the command(s) over
   * the socket, and manages the connection hold state.
   *
   * @param {string | string[]} params - The primary command or an array of commands to send.
   * @param {...Array<string | string[]>} moreParams - Additional commands or parameters.
   * @returns {Promise<IRosGenericResponse[]>} - A promise that resolves with the response from the routerboard.
   */
  public write(
    params: string | string[],
    ...moreParams: Array<string | string[]>
  ): Promise<IRosGenericResponse[]> {
    if (!this.connected) {
      new RosException('ENOTCONN')
    }

    let chann: Channel | null = this.openChannel()
    this.holdConnection()

    chann.once('close', () => {
      chann = null // putting garbage collector to work :]
      this.decreaseChannelsOpen()
      this.releaseConnectionHold()
    })
    return chann.write(this.concatParams(params, moreParams))
  }

  /**
   * Sends the provided command(s) to the routerboard via a new stream channel.
   * Opens a new channel for communication, writes the command(s) over
   * the socket, and manages the connection hold state.
   *
   * @param {string | string[]} params - The primary command or an array of commands to send.
   * @param {...Array<string | string[]>} moreParams - Additional commands or parameters.
   * @returns {RStream} - A stream object for handling continuous data flow.
   */
  public writeStream(
    params: string | string[],
    ...moreParams: Array<string | string[]>
  ): RStream {
    const stream = new RStream(
      this.openChannel(),
      this.concatParams(params, moreParams),
    )

    stream.on('started', () => {
      this.holdConnection()
    })

    stream.on('stopped', () => {
      this.unregisterStream(stream)
      this.decreaseChannelsOpen()
      this.releaseConnectionHold()
    })

    stream.start()

    this.registerStream(stream)

    return stream
  }

  /**
   * Starts a new stream with the provided command(s) and optional callback.
   * If no callback is provided, the function will return the stream object.
   * If a callback is provided, the function will call the callback with the packet data.
   *
   * @param {string | string[]} params - The primary command or an array of commands to send.
   * @returns {RStream} - The stream object.
   */
  public stream<T>(
    params: string | string[] = [],
    callback?: RStreamCallback<T>,
  ): RStream {
    const stream = new RStream(
      this.openChannel(),
      typeof params === 'string' ? [params] : params,
    )

    if (callback) stream.data<T>(callback)

    stream.on('started', () => {
      this.holdConnection()
    })

    stream.on('stopped', () => {
      this.unregisterStream(stream)
      this.decreaseChannelsOpen()
      this.releaseConnectionHold()
      stream.removeAllListeners()
    })

    stream.start()
    stream.prepareDebounceEmptyData()

    this.registerStream(stream)

    return stream
  }

  /**
   * Initiates a keepalive mechanism by executing the provided command(s) at regular intervals.
   * This function ensures that the connection remains active by continuously sending commands
   * to the server. If a callback is provided, it will be called with the packet data on success
   * or an error object on failure.
   *
   * @param {string | string[]} params - The primary command or an array of commands to send.
   * @param {function} [callback] - The callback function to handle the response data.
   */
  public keepaliveBy(
    params: string | string[] = [],
    callback?: (err: Error | null, data: any) => void,
  ): void {
    this.holdingConnectionWithKeepalive = true

    if (this.keptaliveby) clearTimeout(this.keptaliveby)

    /**
     * Executes the keepalive mechanism by scheduling the next command execution
     * unless the connection is in the process of closing. Clears any existing
     * keepalive timeout and sets a new one based on the configured timeout interval.
     * Upon successful execution of the command, the provided callback is invoked
     * with the response data and the function recursively schedules the next execution.
     * In case of an error, the callback is invoked with the error, and the function
     * recursively schedules the next execution.
     */
    const exec = () => {
      if (!this.closing) {
        if (this.keptaliveby) clearTimeout(this.keptaliveby)
        this.keptaliveby = setTimeout(() => {
          this.write(typeof params === 'string' ? [params] : params)
            .then((data) => {
              if (typeof callback === 'function') callback(null, data)
              exec()
            })
            .catch((err: Error) => {
              if (typeof callback === 'function') callback(err, null)
              exec()
            })
        }, 1000)
      }
    }

    exec()
  }

  /**
   * Close the connection to the routerboard. If the connection is already
   * being closed, rejects the promise with the "ALRDYCLOSNG" error.
   *
   * @returns {Promise<RouterOSAPI>} - The current RouterOSAPI instance on success
   */
  public close(): Promise<RouterOSAPI> {
    if (this.closing) {
      return Promise.reject(new RosException('ALRDYCLOSNG'))
    }

    if (!this.connected) {
      return Promise.resolve(this)
    }

    if (this.connectionHoldInterval) {
      clearTimeout(this.connectionHoldInterval)
    }

    if (this.keptaliveby) clearTimeout(this.keptaliveby)

    this.stopAllStreams()

    return new Promise((resolve) => {
      this.closing = true
      this.connector?.once('close', () => {
        this.connector?.destroy()
        this.connector = null
        this.closing = false
        this.connected = false
        resolve(this)
      })
      this.connector?.close()
    })
  }

  /**
   * Creates a new Channel instance and increases the channelsOpen counter.
   * Should be used by methods that need to create a new channel to
   * communicate with the routerboard.
   * @returns {Channel} - The newly created Channel instance
   */
  private openChannel(): Channel {
    if (!this.connector) {
      throw new RosException('ENOTCONN')
    }
    this.increaseChannelsOpen()
    return new Channel(this.connector)
  }

  /**
   * Increments the count of open channels.
   * This function should be called whenever a new channel is opened
   * to keep track of the current number of active channels.
   */
  private increaseChannelsOpen() {
    this.channelsOpen++
  }

  /**
   * Decreases the count of open channels.
   * This function should be called whenever a channel is closed
   * to keep track of the current number of active channels.
   */
  private decreaseChannelsOpen() {
    this.channelsOpen--
  }

  /**
   * Registers a RStream instance to keep track of it.
   * This method is used internally to keep track of all
   * RStream instances created by the RouterOSAPI instance.
   * @param {RStream} stream - RStream instance to be registered
   */
  private registerStream(stream: RStream) {
    this.registeredStreams.push(stream)
  }

  /**
   * Unregisters a RStream instance from the list of registered streams.
   * This function is called internally when a RStream instance is stopped.
   * @param {RStream} stream - RStream instance to be unregistered
   */
  private unregisterStream(stream: RStream) {
    this.registeredStreams = this.registeredStreams.filter(
      (registeredStreams) => registeredStreams !== stream,
    )
  }

  /**
   * Stops all registered RStream instances.
   * This method is called internally when the connection is closed.
   */
  private stopAllStreams() {
    for (const registeredStream of this.registeredStreams) {
      registeredStream.stop()
    }
  }

  /**
   * If there is only one channel open, holds the connection by sending
   * a keepalive message to the routerboard every half of the timeout
   * period. This is necessary because the routerboard will close the
   * connection if no data is received for the timeout period.
   */
  private holdConnection() {
    // If it's not the first connection to open
    // don't try to hold it again
    if (this.channelsOpen !== 1) return

    if (!(this.connected && !this.holdingConnectionWithKeepalive)) {
      return
    }

    if (this.connectionHoldInterval) clearTimeout(this.connectionHoldInterval)

    /**
     * Recursively sets a timeout to send a keepalive message to the routerboard.
     * If the connection is active and a connector is present, it creates a new channel
     * and writes a keepalive message. The function re-invokes itself upon successful
     * writing or in case of an error to ensure continuous keepalive messages are sent.
     * This prevents the connection from timing out if no other data is being sent.
     */
    const holdConnInterval = () => {
      this.connectionHoldInterval = setTimeout(() => {
        let chann = this.connector ? new Channel(this.connector) : null
        chann?.on('close', () => {
          chann = null
        })
        chann
          ?.write(['#'])
          .then(() => {
            holdConnInterval()
          })
          .catch(() => {
            holdConnInterval()
          })
      }, 1000)
    }
    holdConnInterval()
  }

  /**
   * Releases the connection hold by clearing the keepalive interval.
   * If there are no channels open, it clears the keepalive interval,
   * effectively stopping the periodic keepalive messages to the
   * routerboard. If there are still channels open, the function
   * returns early without taking any action.
   */
  private releaseConnectionHold() {
    // If there are channels still open
    // don't release the hold
    if (this.channelsOpen > 0) return

    if (this.connectionHoldInterval) clearTimeout(this.connectionHoldInterval)
  }

  /**
   * Connects to the routerboard using the credentials provided
   * in the constructor. It will either login using the 6.43+
   * method or the old method.
   *
   * @returns {Promise<RouterOSAPI>} - The current instance of the RouterOSAPI
   * class, after it has connected. If the connection fails, it will
   * reject the promise with an error.
   */
  private login(): Promise<RouterOSAPI> {
    this.connecting = true
    info('Sending 6.43+ login to %s', this.host)

    return this.write('/login', [
      `=name=${this.user}`,
      `=password=${this.password}`,
    ])
      .then((data: any[]) => {
        if (data.length === 0) {
          info('6.43+ Credentials accepted on %s, we are connected', this.host)
          return this
        }

        if (data.length === 1) {
          const ret = data[0].ret
          info(
            'Received challenge on %s, will send credentials. Data: %o',
            this.host,
            data,
          )

          const hash = crypto
            .createHash('MD5')
            .update(Buffer.from(`${this.password}${ret}`, 'utf8'))
            .digest('hex')

          return this.write('/login', [
            `=name=${this.user}`,
            `=response=00${hash}`,
          ])
            .then(() => {
              info('Credentials accepted on %s, we are connected', this.host)
              return this
            })
            .catch((err: Error) => {
              const exception =
                err.message === 'cannot log in' ||
                err.message === 'invalid user name or password (6)'
                  ? new RosException('CANTLOGIN')
                  : err
              this.connector?.destroy()
              error("Couldn't loggin onto %s, Error: %O", this.host, exception)
              throw exception
            })
        }

        error(
          'Unknown return from /login command on %s, data returned: %O',
          this.host,
          data,
        )
        throw new RosException('CANTLOGIN')
      })
      .catch((err: Error) => {
        const exception =
          err.message === 'cannot log in' ||
          err.message === 'invalid user name or password (6)'
            ? new RosException('CANTLOGIN')
            : err
        this.connector?.destroy()
        error("Couldn't loggin onto %s, Error: %O", this.host, exception)
        throw exception
      })
  }

  /**
   * Concatenates the given parameters into a single array.
   * If any of the parameters are strings, they are converted to arrays with a single element.
   * If any of the parameters are arrays, they are concatenated into the first parameter.
   * This is useful for generating the
   * parameters for a mikrotik api call
   * @param {string | string[]} firstParameter - The first parameter to be concatenated
   * @param {any[]} parameters - The parameters to be concatenated into the first parameter
   * @returns {string[]} - The concatenated array
   */
  private concatParams(
    firstParameter: string | string[],
    parameters: any[],
  ): string[] {
    const firstParamArray =
      typeof firstParameter === 'string' ? [firstParameter] : firstParameter
    return parameters.reduce((acc, parameter) => {
      const paramArray = typeof parameter === 'string' ? [parameter] : parameter
      return acc.concat(paramArray)
    }, firstParamArray)
  }
}
