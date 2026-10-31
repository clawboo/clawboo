// A delivery the host refused to start, for a reason a person should read.
//
// `deliver` rejects whenever a run could not start. Most rejections are faults
// (a runtime that is not connected, a start that threw), and the engine words
// those itself. A refusal is a decision: the host looked and chose not to start
// the run, for example because a hard-cap budget covering it is paused. Its
// message says why in words fit for the board and the chat, so the engine
// records it as the failure instead of a generic "could not deliver".

export class DeliveryRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeliveryRefusedError'
  }
}
