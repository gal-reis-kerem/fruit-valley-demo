// Voice-note transcription (Hebrew) via OpenAI Whisper. Claude has no audio
// input, so voice notes are transcribed first and the TEXT runs through the
// normal order flow. Requires OPENAI_API_KEY; without it the caller falls
// back to a manual-review alert (never a silent drop, never a wrong guess).
const log = require('../logger');

function available() {
  return Boolean(process.env.OPENAI_API_KEY);
}

async function transcribeAudio(buffer, mimetype = 'audio/ogg') {
  if (!available()) return null;
  const ext = /mpeg|mp3/.test(mimetype) ? 'mp3' : /mp4|m4a/.test(mimetype) ? 'm4a' : /wav/.test(mimetype) ? 'wav' : 'ogg';
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimetype.split(';')[0] }), `voice.${ext}`);
  form.append('model', 'whisper-1');
  form.append('language', 'he');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Whisper HTTP ${res.status}${body ? `: ${body.slice(0, 120)}` : ''}`);
  }
  const data = await res.json();
  const text = (data.text || '').trim();
  log.info(`הודעה קולית תומללה (${(buffer.length / 1024).toFixed(0)}KB): "${text.slice(0, 80)}"`);
  return text || null;
}

module.exports = { transcribeAudio, available };
