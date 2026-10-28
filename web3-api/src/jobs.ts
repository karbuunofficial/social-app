/**
 * Runs `fn` repeatedly, never overlapping itself, never throwing out of the
 * loop. Returns a function that stops the loop and waits for a run in flight.
 */
export function startLoop(
  name: string,
  intervalMs: number,
  fn: () => Promise<unknown>,
  log: (obj: Record<string, unknown>, msg: string) => void,
): () => Promise<void> {
  let stopped = false
  let timer: NodeJS.Timeout | undefined
  let running: Promise<void> = Promise.resolve()

  const tick = () => {
    if (stopped) return
    running = fn()
      .then(() => undefined)
      .catch(err => log({err, job: name}, 'background job failed'))
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, intervalMs)
      })
  }
  timer = setTimeout(tick, 0)

  return async () => {
    stopped = true
    if (timer) clearTimeout(timer)
    await running
  }
}
