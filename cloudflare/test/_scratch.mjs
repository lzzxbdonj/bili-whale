import * as old from '../../lib/policy.js';
import * as oldLedger from '../../lib/ledger.js';
const ledger = oldLedger.emptyLedger();
const cfg = { ownerMid: 4242, policy: { postVideoComment: 'confirm', postReply: 'confirm', postDynamic: 'confirm', ownerUnlimited: true, replyPerUserPerThread: 1, replyPerUserWindowHours: 24, dailyVideoComments: 3, dailyReplies: 10, dailyDynamics: 1, minIntervalSeconds: 120, minIntervalSecondsOwner: 15, maxCommentChars: 200, blockKeywords: ['加群'], dedupePerVideo: true } };
console.log(JSON.stringify(old.checkVideoComment({ cfg, ledger, video: { bvid: 'BV1' }, message: 'hi' })));
console.log(JSON.stringify(old.checkReply({ cfg, ledger, target: { root: 0, rpid: 9, mid: 7, uname: '甲' }, message: 'hi' })));
console.log(JSON.stringify(old.checkDynamic({ cfg, ledger, text: 'hi' })));
console.log(JSON.stringify(oldLedger.todayCounts(ledger)));
