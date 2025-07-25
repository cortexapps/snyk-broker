
export const computeContentLength = (payload): number => {
  let contentLength = 0;
  if (!payload.body || payload.body.length === 0) {
    contentLength = 0;
  } else  {
    contentLength = Buffer.byteLength(payload.body, 'utf8');
  }
  return contentLength;
};
