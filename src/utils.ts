/**
 * Returns an object with `run` and `cancel` methods. The `run` method queues
 * the provided callback to be called with the provided arguments after the
 * specified timeout. If the `run` method is called again before the timeout
 * has expired, the previous call is cancelled and the timeout is reset. The
 * `cancel` method can be called to cancel any pending call.
 *
 * @param {Function} callback - The function to be called after the timeout.
 * @param {Number} [timeout=0] - The number of milliseconds to wait before calling
 * the callback.
 * @returns {Object} - An object with `run` and `cancel` methods.
 */
export const debounce = (callback: (...args: any) => void, timeout = 0) => {
  let timeoutObj: NodeJS.Timeout | string | number | undefined = undefined

  return {
    /**
     * Schedules the callback to be called with the provided arguments after
     * the specified timeout. If this method is called again before the timeout
     * has expired, the previous call is cancelled and the timeout is reset.
     * @param {...any} args - The arguments to be passed to the callback.
     */
    run: (...args: any) => {
      clearTimeout(timeoutObj)
      timeoutObj = setTimeout(() => callback.apply(this, args), timeout)
    },

    /**
     * Cancels any pending call to the callback. If no callback is currently
     * scheduled, this method does nothing.
     */
    cancel: () => {
      clearTimeout(timeoutObj)
    },
  }
}
