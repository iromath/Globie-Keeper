/**
 * The user manual (DEV_PLAN §2.22).
 *
 * One copy, two readers: `GET /help` serves these sections to the Help page,
 * and `chatReply` folds a digest of the closest matches into Globie's prompt so
 * the assistant answers "how do I…" questions with the same words the screen
 * uses. Button labels are quoted from the real components — when a label
 * changes, change it here and both readers follow.
 *
 * Nothing in here is user data: every section is safe to serve to a signed-out
 * visitor and to cache.
 */

export type ManualSection = {
  id: string;
  title: string;
  /** One line, shown in the Help index and the assistant's section index. */
  summary: string;
  /** Lower-case fragments matched against the member's question. */
  keywords: string[];
  /** The walkthrough, in the order the member does it. */
  steps: string[];
  /** Where it happens: a route the Help page can link to. */
  screen: string | null;
};

export const MANUAL: ManualSection[] = [
  {
    id: 'getting-started',
    title: 'Getting started',
    summary: 'Sign in, then start or join a group.',
    keywords: ['sign in', 'signin', 'log in', 'login', 'sign up', 'signup', 'account', 'password', 'register', 'new here', 'start', 'begin'],
    steps: [
      'Open the app and sign in with your email and password on the sign-in screen. New here? Fill the same form and tap "Create account".',
      'Home is the first tab. It shows what you owe, your Globie points, your groups and the open shares.',
      'The tab bar along the bottom holds Home, Groups, Donate, Shares and Activity.',
    ],
    screen: '/',
  },
  {
    id: 'group',
    title: 'Start or join a group',
    summary: 'A group holds the agreement and the bills for one crew.',
    keywords: ['group', 'create', 'join', 'invite', 'code', 'qr', 'crew', 'friends', 'add people', 'new group'],
    steps: [
      'On Home, the "Start a group" card asks for a name and a currency. Tap "Create group".',
      'Pick the currency members are reimbursed in — every bill in the group uses it.',
      'Share the group code from the group screen so others can join, or let them scan its QR code.',
      'To join, paste the code into "Join with a code" on Home and tap "Join group", or tap "Scan the QR code".',
      'Your groups are listed on the Groups tab.',
    ],
    screen: '/groups',
  },
  {
    id: 'agreement',
    title: 'Set the agreement',
    summary: 'Everyone taps once, so nobody argues later about who said they were in.',
    keywords: ['agreement', 'terms', 'agree', 'consent', 'rules', 'fronted', 'front', 'who paid'],
    steps: [
      'Open the group. Under "Who is in", tap "Set the agreement".',
      'Name who fronted the money and the split rules, then tap "Create agreement".',
      'Every member opens the group and taps "I agree to these terms".',
      'A bill cannot be captured until the agreement exists.',
    ],
    screen: '/groups/[id]',
  },
  {
    id: 'capture',
    title: 'Capture a bill',
    summary: 'Photograph the receipt and Globie reads the lines.',
    keywords: ['bill', 'receipt', 'capture', 'photo', 'camera', 'picture', 'scan', 'upload', 'line', 'item', 'add line', 'merchant'],
    steps: [
      'Open the group, then open its bill.',
      'Tap "Take a photo" or "Pick a photo or video". Globie reads the receipt while the screen says "Reading the bill".',
      'Check every line and correct any price or name it misread.',
      'Add anything the receipt missed with "Add a line by hand", then "Add line".',
    ],
    screen: '/groups/[id]/bill',
  },
  {
    id: 'split',
    title: 'Split the bill',
    summary: 'Assign each line, then lock the split.',
    keywords: ['split', 'share', 'assign', 'divide', 'who had', 'lock', 'allocation', 'how much each', 'portion'],
    steps: [
      'Under "How to split", assign each line to the members who had it.',
      'Tap "Lock the split" once every line is assigned.',
      'Locking the split posts each member\'s share; the shares then wait for confirmation. If you change a line later, tap "Save split" again.',
    ],
    screen: '/groups/[id]/bill',
  },
  {
    id: 'confirm',
    title: 'Confirm your share',
    summary: 'Each member checks their own lines before paying.',
    keywords: ['confirm', 'mine', 'my share', 'accept', 'disagree', 'finalize', 'finalized', 'approve lines', 'these are mine'],
    steps: [
      'Open the group and tap the bill. Your own lines are listed with your share.',
      'Check the amount, then tap "Confirm your share".',
      'If a line is not yours, use the line controls and tap "These are mine" before confirming.',
      'When everyone has confirmed, the bill finalizes and the shares become payable.',
    ],
    screen: '/groups/[id]/bill',
  },
  {
    id: 'request',
    title: 'Request reimbursement (fronter)',
    summary: 'The fronter asks PayPal for each outstanding share.',
    keywords: ['request', 'reimbursement', 'collect', 'fronter', 'paypal email', 'send request', 'charge', 'get paid back', 'request payment'],
    steps: [
      'Only the fronter — the member who paid the merchant — can ask for money back.',
      'First add your PayPal address in Settings under "Getting paid": "Save PayPal email", or a PayPal.Me handle with "Save handle".',
      'On the bill, open "Reimbursement" and tap "Request payment".',
      'Tap "Send PayPal requests" to ask every member who still owes.',
      'If someone loses the link, tap "Send PayPal requests" again, then "Copy link" beside their name and send it to them.',
    ],
    screen: '/groups/[id]/bill',
  },
  {
    id: 'pay',
    title: 'Pay your share',
    summary: 'Pay through PayPal from your shares list or the bill.',
    keywords: ['pay', 'payment', 'owe', 'paypal', 'checkout', 'link', "i've paid", 'finish payment', 'settle', 'pay my share'],
    steps: [
      'Open the "Shares" tab to see everything you owe.',
      'Tap "Pay" on a requested share to open PayPal. If the PayPal window closed early, tap "Finish payment".',
      'With a PayPal.Me fronter, send the money from the link, then tap "I\'ve paid".',
      'No button at all means the fronter has not requested payment yet — the row says who it is waiting for.',
    ],
    screen: '/me/shares',
  },
  {
    id: 'tip',
    title: 'Tip the fronter',
    summary: 'Say thanks with a small PayPal tip worth +2 Globie.',
    keywords: ['tip', 'tipping', 'thanks', 'thank', 'gratuity', 'extra', 'reward the fronter'],
    steps: [
      'Open the bill once it is finalized.',
      'Use the "Tip the fronter" card and pick a suggested amount, or type your own.',
      'Pay through PayPal. The money goes straight to the fronter — Globie never holds it.',
      'One tip per member, and the fronter cannot tip themselves.',
    ],
    screen: '/groups/[id]/bill',
  },
  {
    id: 'points',
    title: 'Globie points and the leaderboard',
    summary: 'Points track engagement; 1,000 points are worth US$1.',
    keywords: ['points', 'globie points', 'leaderboard', 'score', 'rank', 'reward', 'hero', 'fronted the most', 'balance'],
    steps: [
      'Your points show on Home and in each group\'s "Leaderboard".',
      'Confirming your share, paying, and tipping earn points — a tip is worth +2 Globie.',
      '1,000 Globie points equal US$1; one point is one tenth of a cent.',
      'The leaderboard answers "Who fronted the most this month?".',
    ],
    screen: '/groups/[id]/leaderboard',
  },
  {
    id: 'fund',
    title: 'Give to the Globie Fund',
    summary: 'Adopt a tree with PayPal or with Globie points.',
    keywords: ['donate', 'donation', 'fund', 'tree', 'adopt', 'species', 'gift', 'redeem', 'charity', 'give', 'plant'],
    steps: [
      'Open the "Donate" tab.',
      'Under "Who to adopt", pick a species.',
      'Choose a price per tree under "Your gift" — a preset or your own amount — then use + / − to pick how many trees; the total follows.',
      'Tap the PayPal button to pay, or tap "Redeem" to spend points you already have.',
      'Your gifts are listed under "Your giving".',
    ],
    screen: '/donate',
  },
  {
    id: 'settings',
    title: 'Settings',
    summary: 'Where you get paid and how Globie nudges you.',
    keywords: ['settings', 'paypal email', 'profile', 'notification', 'notifications', 'sign out', 'phone', 'handle', 'merchant', 'account'],
    steps: [
      'Open the Activity tab and tap the Settings cog, or use the "Help & manual" row on that screen.',
      'Under "Getting paid", choose "PayPal order" (merchant account) or "PayPal.Me link" (personal account), then save the address members should pay.',
      'Under "Where to reach me", switch the channels Globie may use. Quiet hours are 22:00 to 08:00.',
      'Under "This device", turn on push or sign out.',
    ],
    screen: '/settings',
  },
  {
    id: 'help',
    title: 'Ask Globie for help',
    summary: 'Globie answers questions about the app on the Help page.',
    keywords: ['help', 'manual', 'guide', 'how to', 'question', 'support', 'assistant', 'chat', 'explain', 'what is'],
    steps: [
      'Open "Help & manual" from the Activity header, the Settings screen, the Home card, or the sign-in screen.',
      'Search the manual or read a section.',
      'Type a question such as "How do I pay my share?" and Globie answers with the exact screen and button names.',
      'Globie can explain the app but cannot move money or change a bill.',
    ],
    screen: '/help',
  },
  {
    id: 'troubleshooting',
    title: 'If something looks wrong',
    summary: 'The row on your share usually says what it is waiting for.',
    keywords: ['problem', 'wrong', 'not working', "can't", 'cannot', 'stuck', 'zero', 'failed', 'error', 'no button', 'waiting', 'expired', 'missing'],
    steps: [
      '"Waiting on you" means your lines need checking — open the bill and tap "Confirm your share".',
      '"Waiting for … to request payment" means the fronter has not sent the request yet.',
      'No Pay button at all: the payment link may have expired; ask the fronter to send the request again.',
      '"Didn\'t go through, nothing was charged" means PayPal declined — ask the fronter for a new request.',
      'A share of zero means you had no lines on the bill; ask the fronter to assign yours under "How to split".',
      'The fronter cannot request payment until a PayPal email or handle is saved in Settings under "Getting paid".',
      'The tip card only appears once the bill is finalized, and never for the fronter.',
    ],
    screen: '/me/shares',
  },
];

const TITLE_WEIGHT = 2;
const PHRASE_BONUS = 1;

function score(section: ManualSection, haystack: string): number {
  let total = 0;
  for (const keyword of section.keywords) {
    if (!haystack.includes(keyword)) continue;
    total += TITLE_WEIGHT + (keyword.includes(' ') ? PHRASE_BONUS : 0);
  }
  return total;
}

/** The sections closest to the question, best first; ties keep manual order. */
export function relatedManual(message: string, limit = 2): ManualSection[] {
  const haystack = ` ${message.toLowerCase()} `;
  return MANUAL.map((section, index) => ({ section, index, score: score(section, haystack) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.section);
}

/**
 * What the model needs, and no more: every section by title and summary (a map
 * of the whole app), plus the steps of the closest matches (~150 tokens rather
 * than the whole manual).
 */
export function manualDigest(message: string, limit = 2): string {
  const index = MANUAL.map((section) => `- ${section.title}: ${section.summary}`).join('\n');
  const detail = relatedManual(message, limit)
    .map((section) =>
      [`[${section.title}]`, ...section.steps.map((step) => `- ${step}`)].join('\n'),
    )
    .join('\n\n');

  return detail ? `SECTIONS\n${index}\n\nDETAIL\n${detail}` : `SECTIONS\n${index}`;
}
