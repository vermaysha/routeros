import messages from './messages'

/**
 * RouterOS Exception Handler
 */
export class RosException extends Error {
  public errno: string

  constructor(errno: keyof typeof messages, extras?: any) {
    super()

    // Maintains proper stack trace for where our error was thrown
    Error.captureStackTrace(this, this.constructor)

    this.name = this.constructor.name

    // Custom debugging information
    this.errno = errno

    let message = messages[errno]

    if (message) {
      for (const key in extras) {
        if (Object.prototype.hasOwnProperty.call(extras, key)) {
          message = message.replace(`{{${key}}}`, extras[key])
        }
      }
      this.message = message
    }
  }
}
