import { EventEmitter } from 'node:events'
import { Channel } from './Channel'
import { RosException } from './RosException'
import { setTimeout, clearTimeout } from 'node:timers'
import { debounce } from './utils'

export type RStreamCallback<T> = (
  err: Error | null,
  packet?: T,
  stream?: RStream,
) => void

/**
 * Stream class is responsible for handling
 * continuous data from some parts of the
 * routeros, like /ip/address/listen or
 * /tool/torch which keeps sending data endlessly.
 * It is also possible to pause/resume/stop generated
 * streams.
 */
export class RStream extends EventEmitter {
  /**
   * Callback function to receive data
   * from the routerboard
   */
  private callback?: RStreamCallback<any>
  /**
   * The function that will send empty data
   * unless debounced by real data from the command
   */
  private debounceSendingEmptyData: any

  /** Flag for turning on empty data debouncing */
  private shouldDebounceEmptyData = false

  /**
   * If is streaming flag
   */
  private streaming = true

  /**
   * If is pausing flag
   */
  private pausing = false

  /**
   * If is paused flag
   */
  private paused = false

  /**
   * If is stopping flag
   */
  private stopping = false

  /**
   * If is stopped flag
   */
  private stopped = false

  /**
   * If got a trap error
   */
  private trapped = false

  /**
   * Save the current section of the packet, if has any
   */
  private currentSection: string | null = null

  /**
   * Forcely stop the stream
   */
  private forcelyStop = false

  /**
   * Store the current section in a single
   * array before sending when another section comes
   */
  private currentSectionPacket: any[] = []

  /**
   * Waiting timeout before sending received section packets
   */
  private sectionPacketSendingTimeout: ReturnType<typeof setTimeout> | null =
    null

  /**
   * Creates a new stream to be sent to the routerboard
   *
   * @param channel - The channel which will be used to send the command
   * @param params - The command parameters to be sent
   * @param callback - The callback that will receive the data from the routerboard
   */
  constructor(
    private channel: Channel,
    private params: string[],
  ) {
    super()
  }

  /**
   * Function to receive the callback which
   * will receive data, if not provided over the
   * constructor or changed later after the streaming
   * have started.
   *
   * @param {function} callback
   */
  public data<T>(callback: RStreamCallback<T>): void {
    this.callback = callback
  }

  /**
   * Resumes the stream if it is not currently streaming.
   * If the stream is stopped or stopping, a rejection error
   * with "STREAMCLOSD" is returned. Otherwise, it resets the
   * pausing state, starts the stream, and sets the streaming
   * flag to true.
   *
   * @returns {Promise<void>} - A promise that resolves when the stream
   * is successfully resumed or rejects if the stream is closed.
   */
  public resume(): Promise<void> {
    if (this.stopped || this.stopping)
      return Promise.reject(new RosException('STREAMCLOSD'))

    if (!this.streaming) {
      this.pausing = false
      this.start()
      this.streaming = true
    }

    return Promise.resolve()
  }

  /**
   * Pauses the stream if it is not currently paused or stopping.
   * If the stream is stopped or stopping, a rejection error
   * with "STREAMCLOSD" is returned. Otherwise, it sets the
   * pausing flag to true, stops the stream, and sets the paused
   * flag to true.
   *
   * @returns {Promise<void>} - A promise that resolves when the stream
   * is successfully paused or rejects if the stream is closed.
   */
  public pause(): Promise<void> {
    if (this.stopped || this.stopping)
      return Promise.reject(new RosException('STREAMCLOSD'))

    if (this.pausing || this.paused) return Promise.resolve()

    if (this.streaming) {
      this.pausing = true
      return this.stop(true)
        .then(() => {
          this.pausing = false
          this.paused = true
          return Promise.resolve()
        })
        .catch((err) => {
          return Promise.reject(err)
        })
    }

    return Promise.resolve()
  }

  /**
   * Stops the stream if it is not currently stopped or stopping.
   * If the stream is stopped or stopping, a rejection error
   * with "STREAMCLOSD" is returned. Otherwise, it sets the
   * stopping flag to true and sends a /cancel command to the
   * channel. If the pausing flag is set to true, the stream is
   * paused and the stopped flag is set to false.
   *
   * @param {boolean} [pausing=false] - If true, the stream is paused instead of stopped.
   * @returns {Promise<void>} - A promise that resolves when the stream
   * is successfully stopped or rejects if the stream is closed.
   */
  public async stop(pausing = false): Promise<void> {
    if (this.stopped || this.stopping) return Promise.resolve()

    if (!pausing) this.forcelyStop = true

    if (this.paused) {
      this.streaming = false
      this.stopping = false
      this.stopped = true
      if (this.channel) this.channel.close(true)
      return Promise.resolve()
    }

    if (!this.pausing) this.stopping = true

    let chann: Channel | null = new Channel(this.channel.connector)
    chann.on('close', () => {
      chann = null
    })

    if (this.debounceSendingEmptyData) this.debounceSendingEmptyData.cancel()

    try {
      await chann.write(['/cancel', `=tag=${this.channel.id}`])
      this.streaming = false
      if (!this.pausing) {
        this.stopping = false
        this.stopped = true
      }
      this.emit('stopped')
      return await Promise.resolve()
    } catch (err) {
      return await Promise.reject(err)
    }
  }

  /**
   * Close the stream. Calls `stop()` internally
   *
   * @returns {Promise<void>} - A promise that resolves when the stream
   * is successfully closed or rejects if the stream is closed.
   */
  public close(): Promise<void> {
    return this.stop()
  }

  /**
   * Start the stream if it is not currently streaming.
   * If the stream is stopped or stopping, a rejection error
   * with "STREAMCLOSD" is returned. Otherwise, it resets the
   * stopping state, starts the stream, and sets the streaming
   * flag to true.
   *
   * @returns {void}
   */
  public start(): void {
    if (!(!this.stopped && !this.stopping)) {
      return
    }

    this.channel.on('close', () => {
      if (this.forcelyStop || (!this.pausing && !this.paused)) {
        if (!this.trapped) this.emit('done')
        this.emit('close')
      }
      this.stopped = false
    })

    this.channel.on('stream', (packet: any) => {
      if (this.debounceSendingEmptyData) this.debounceSendingEmptyData.run()
      this.onStream(packet)
    })

    this.channel.once('trap', this.onTrap.bind(this))
    this.channel.once('done', this.onDone.bind(this))

    this.channel.write(this.params.slice(), true, false)

    this.emit('started')

    if (this.shouldDebounceEmptyData) this.prepareDebounceEmptyData()
  }

  /**
   * Prepares the debounce mechanism for sending empty data packets
   * at a determined interval. This is used to ensure that the stream
   * remains active by invoking the onStream method with an empty
   * packet when no data is being received.
   *
   * It checks for an `=interval=` parameter within the stream's
   * parameters to determine the debounce interval. If the parameter
   * is found, the interval is set based on its value, otherwise,
   * a default interval of 2000 milliseconds is used. The interval
   * is adjusted by adding 300 milliseconds to it.
   *
   * This method sets the `shouldDebounceEmptyData` flag to true
   * and initializes the `debounceSendingEmptyData` function
   * using the calculated interval.
   */
  public prepareDebounceEmptyData() {
    this.shouldDebounceEmptyData = true

    const intervalParam = this.params.find((param) => {
      return /=interval=/.test(param)
    })

    let interval = 2000
    if (intervalParam) {
      const val = intervalParam.split('=')[2]
      if (val) {
        interval = Number.parseInt(val) * 1000
      }
    }

    this.debounceSendingEmptyData = debounce(() => {
      if (!this.stopped || !this.stopping || !this.paused || !this.pausing) {
        this.onStream([])
        this.debounceSendingEmptyData.run()
      }
    }, interval + 300)
  }

  /**
   * Called when the stream emits data. If the packet is a section packet,
   * it collects all packets with the same section name and sends them
   * to the callback after a 300ms delay. If the packet is not a section
   * packet, it is sent to the callback immediately.
   * @param {any} packet
   * @memberof RStream
   * @private
   */
  private onStream(packet: any): void {
    this.emit('data', packet)
    if (this.callback) {
      if (packet['.section']) {
        if (this.sectionPacketSendingTimeout)
          clearTimeout(this.sectionPacketSendingTimeout)

        const sendData = () => {
          this.callback?.(null, this.currentSectionPacket.slice(), this)
          this.currentSectionPacket = []
        }

        this.sectionPacketSendingTimeout = setTimeout(sendData.bind(this), 300)

        if (
          this.currentSectionPacket.length > 0 &&
          packet['.section'] !== this.currentSection
        ) {
          clearTimeout(this.sectionPacketSendingTimeout)
          sendData()
        }

        this.currentSection = packet['.section']
        this.currentSectionPacket.push(packet)
      } else {
        this.callback(null, packet, this)
      }
    }
  }

  /**
   * Handles the trap event, which is emitted when the stream is interrupted
   * or when an error occurs. If the trap is due to an interruption, it sets
   * the `streaming` flag to false. If the trap is due to an error, it sets
   * the `stopped` and `trapped` flags to true, calls the callback with the
   * error if it is defined, and emits an "error" event with the error.
   * @private
   * @param {any} data
   */
  private onTrap(data: any): void {
    if (data.message === 'interrupted') {
      this.streaming = false
      return
    }

    this.stopped = true
    this.trapped = true
    if (this.callback) {
      this.callback(new Error(data.message), null, this)
    } else {
      this.emit('error', data)
    }
    this.emit('trap', data)
  }

  /**
   * Handles the "done" event. If the stream is stopped and the channel is
   * defined, it closes the channel with the force flag set to true.
   * @private
   */
  private onDone(): void {
    if (this.stopped && this.channel) {
      this.channel.close(true)
    }
  }
}
