import { ApiError } from '../api/errors';
export function parseArgv(input: string): string[] {
  if (input.length > 32768) throw new ApiError('invalid');
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new ApiError('invalid');
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 128 ||
    value.some((v) => typeof v !== 'string' || v.includes('\0')) ||
    typeof value[0] !== 'string' ||
    !value[0].trim()
  )
    throw new ApiError('invalid');
  return value as string[];
}
