import { loadSession } from './lib/cookies.js';
import { BiliClient } from './lib/api.js';
import { resolveConfig } from './lib/config.js';
const session = loadSession();
const c = new BiliClient({ config: resolveConfig({}), session });
const sessions = await c.dmSessions({ size: 5 });
console.log('sessions:', JSON.stringify(sessions, null, 2));
const talker = sessions[0]?.talkerId;
if (talker) {
  const msgs = await c.dmMessages({ talkerId: talker, size: 6 });
  console.log('messages:', JSON.stringify(msgs.messages, null, 2));
}
