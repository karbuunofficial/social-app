import {loadConfig} from '../config.ts'
import {migrate} from './migrate.ts'

const direction = process.argv[2] === 'down' ? 'down' : 'up'
const count = direction === 'down' ? 1 : Infinity

const config = loadConfig()
const names = await migrate(config.DATABASE_URL, direction, count)
console.log(
  names.length
    ? `${direction}: ${names.join(', ')}`
    : `${direction}: nothing to do`,
)
