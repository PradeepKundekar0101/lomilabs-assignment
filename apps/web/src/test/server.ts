import { setupServer } from 'msw/node'

/** The API, as MSW: each test installs the handlers it needs. */
export const server = setupServer()
