import { log as logger } from './logger';

export const formatBodyForLog = (body: unknown, headers?: Record<string, string>): unknown => {
  if (!(body instanceof Uint8Array)) {
    return body;
  }
  const contentType = (headers?.['content-type'] || '').toLowerCase();
  const isTextContent =
    contentType.startsWith('text/') || contentType.includes('json');
  if (isTextContent) {
    return Buffer.from(body).toString('utf-8');
  }
  const preview = Buffer.from(body.slice(0, 32)).toString('utf-8');
  return `[Binary] '${preview}'... ${body.length} bytes`;
};

export const logResponse = (logContext, status, response, config) => {
  logContext.responseStatus = status;
  logContext.responseHeaders = response.headers;

  logContext.responseBody =
    config && config.LOG_ENABLE_BODY === 'true'
      ? formatBodyForLog(response.body, response.headers)
      : null;

  logger.info(logContext, 'sending response back to websocket connection');
};

export const logError = (logContext, error) => {
  logger.error(
    {
      ...logContext,
      error,
      stackTrace: new Error('stacktrace generator').stack,
    },
    'error while sending websocket request over HTTP connection',
  );
};
