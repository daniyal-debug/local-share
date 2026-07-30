/**
 * Serverless entry point (Vercel).
 *
 * This exists so the deployment stops returning FUNCTION_INVOCATION_FAILED and
 * the page renders. It does NOT make the app work: a serverless function has no
 * shared memory between invocations and cannot hold a WebSocket, so plates are
 * not visible across devices and nothing syncs live. Read the deployment section
 * of the README before relying on a hosted copy.
 */
export { default } from '../server.js';
