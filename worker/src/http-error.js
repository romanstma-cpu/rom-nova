// An error that already knows how to be answered: the status and the line
// the client reads. Thrown by the desk, the keys and the API; the router
// turns it into a response and lets everything else become a 500.

export class HttpError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
