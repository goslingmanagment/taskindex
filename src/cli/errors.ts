import { errorCodeSchema } from '../shared/domain-schemas.js';
import { z } from '../shared/schemas.js';

// Codes the CLI adds to the server's: they never come from the API and never
// settle an envelope on their own.
export const CLI_ONLY_CODES = [
  'invalid_arguments',
  'client_error',
  'network_error',
  'invalid_response',
  'admin_error',
] as const;

export const CLI_ERROR_CODES = [
  ...errorCodeSchema.options,
  ...CLI_ONLY_CODES,
] as const;

export const cliErrorCodeSchema = z.enum(CLI_ERROR_CODES);
export type CliErrorCode = z.infer<typeof cliErrorCodeSchema>;
