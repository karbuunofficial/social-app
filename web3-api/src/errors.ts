import {type FastifyError, type FastifyInstance} from 'fastify'
import {ZodError} from 'zod'

/**
 * An error that is safe to show to API clients. Anything that is not an
 * AppError is reported as a generic 500 and logged server-side.
 */
export class AppError extends Error {
  readonly statusCode: number
  readonly code: string

  constructor(statusCode: number, code: string, message: string) {
    super(message)
    this.name = 'AppError'
    this.statusCode = statusCode
    this.code = code
  }
}

export const badRequest = (code: string, message: string) =>
  new AppError(400, code, message)
export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'unauthorized', message)
export const forbidden = (code: string, message: string) =>
  new AppError(403, code, message)
export const notFound = (code: string, message: string) =>
  new AppError(404, code, message)
export const conflict = (code: string, message: string) =>
  new AppError(409, code, message)
export const unprocessable = (code: string, message: string) =>
  new AppError(422, code, message)
export const notImplemented = (message: string) =>
  new AppError(501, 'not_implemented', message)

type ErrorBody = {error: {code: string; message: string; issues?: unknown}}

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof AppError) {
      const body: ErrorBody = {
        error: {code: err.code, message: err.message},
      }
      return reply.status(err.statusCode).send(body)
    }
    if (err instanceof ZodError) {
      const body: ErrorBody = {
        error: {
          code: 'validation_error',
          message: 'Request validation failed',
          // Path and reason only; never echo submitted values.
          issues: err.issues.map(i => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
      }
      return reply.status(400).send(body)
    }
    const status = 'statusCode' in err ? err.statusCode : undefined
    if (status && status >= 400 && status < 500) {
      // Fastify's own client errors (malformed JSON, payload too large, ...).
      const body: ErrorBody = {
        error: {code: 'bad_request', message: 'The request was rejected'},
      }
      return reply.status(status).send(body)
    }
    req.log.error({err}, 'unhandled error')
    const body: ErrorBody = {
      error: {code: 'internal_error', message: 'Internal server error'},
    }
    return reply.status(500).send(body)
  })

  app.setNotFoundHandler((_req, reply) => {
    const body: ErrorBody = {
      error: {code: 'not_found', message: 'Route not found'},
    }
    return reply.status(404).send(body)
  })
}
