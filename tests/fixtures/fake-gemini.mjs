/**
 * A stand-in for the Gemini API, for the AI Studio MCP server to talk to.
 *
 * @google/genai reads GOOGLE_GEMINI_BASE_URL, so a server started with it set
 * to this address sends everything here instead of to Google. It answers the
 * three things the PDF paths use -- generateContent, the resumable File API
 * upload, and the models.get probe the key check makes -- and records every
 * request, so a test can say what was and was not sent.
 */
import { createServer } from 'node:http';

export const FAKE_ANSWER = 'fake gemini answer';

export async function startFakeGemini() {
  const requests = [];
  let uploads = 0;

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let body = null;
      try { body = JSON.parse(raw.toString('utf8')); } catch { /* binary upload chunk */ }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body, bytes: raw.length });

      const { port } = server.address();
      const json = (status, payload, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(payload));
      };

      if (req.method === 'POST' && req.url.startsWith('/upload/')) {
        // Start of a resumable upload: say where to send the bytes.
        uploads += 1;
        return json(200, {}, { 'x-goog-upload-url': `http://127.0.0.1:${port}/upload-session/${uploads}` });
      }
      if (req.method === 'POST' && req.url.startsWith('/upload-session/')) {
        const id = req.url.split('/').pop();
        return json(200, {
          file: {
            name: `files/fake-${id}`,
            uri: `https://generativelanguage.googleapis.com/v1beta/files/fake-${id}`,
            mimeType: 'application/pdf',
            state: 'ACTIVE',
          },
        }, { 'x-goog-upload-status': 'final' });
      }
      if (req.method === 'POST' && req.url.includes(':generateContent')) {
        return json(200, {
          candidates: [{ content: { role: 'model', parts: [{ text: FAKE_ANSWER }] }, finishReason: 'STOP' }],
        });
      }
      if (req.method === 'GET' && req.url.includes('/models/')) {
        const name = req.url.split('?')[0].split('/models/').pop();
        return json(200, { name: `models/${name}`, displayName: name });
      }
      return json(404, { error: { code: 404, message: `fake gemini: no route for ${req.method} ${req.url}`, status: 'NOT_FOUND' } });
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    /** generateContent request bodies, in order. */
    generateCalls: () => requests.filter(r => r.url.includes(':generateContent')).map(r => r.body),
    /** Resumable upload starts, in order. */
    uploadStarts: () => requests.filter(r => r.method === 'POST' && r.url.startsWith('/upload/')),
    reset: () => { requests.length = 0; },
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
