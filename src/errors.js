export class DtError extends Error {
  constructor(message, code = -32000, data) {
    super(message);
    this.name = 'DtError';
    this.code = code;
    this.data = data;
  }
}

export function asRpcError(error) {
  return {
    code: Number.isInteger(error?.code) ? error.code : -32000,
    message: error?.message || String(error),
    ...(error?.data === undefined ? {} : { data: error.data }),
  };
}

export function formatError(error, json = false) {
  const body = asRpcError(error);
  if (json) return JSON.stringify({ ok: false, error: body });
  const lines = [`error: ${body.message}`];
  for (const key of ['selector', 'url', 'title']) {
    if (body.data?.[key] !== undefined) lines.push(`${key}: ${body.data[key]}`);
  }
  if (body.data?.stack) lines.push(body.data.stack);
  return lines.join('\n');
}
