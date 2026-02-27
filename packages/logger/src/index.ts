import pino from 'pino'

export const logger = pino({
  name: 'clawboo',
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
})

export const createLogger = (module: string) => logger.child({ module })

export type Logger = ReturnType<typeof logger.child>
