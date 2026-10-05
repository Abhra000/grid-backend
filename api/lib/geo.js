// P-07: when a user picks an RTO (e.g. WB-01), rows whose RTO is "All" should only show if their
// Location is in the same state (West Bengal, Kolkata, Rest of West Bengal …) or is not tied to a state
// (All, All India, North (Ref) …). Location text -> RTO state codes, using state names + city names.
const KW = {
  AN: ['andaman', 'nicobar'],
  AP: ['andhra', 'chittoor', 'east godavari', 'west godavari', 'guntur', 'krishna', 'nellore', 'vijayawada', 'visakhapatnam', 'visakhapatanam', 'vizag', 'tirupati'],
  AR: ['arunachal', 'north east', 'north-east'],
  AS: ['assam', 'kamrup', 'guwahati', 'jorhat', 'dibrugarh', 'tinsukia', 'nagaon', 'north east', 'north-east'],
  BR: ['bihar', 'bhagalpur', 'gaya', 'muzaffarpur', 'patna', 'purnia'],
  CH: ['chandigarh'],
  CG: ['chhattisgarh', 'durg', 'raipur', 'bilaspur'],
  DD: ['daman', 'diu', 'vapi'],
  DN: ['dadra', 'nagar haveli', 'silvassa'],
  DL: ['delhi', 'ncr'],
  GA: ['goa'],
  GJ: ['gujarat', 'ahmedabad', 'baroda', 'vadodara', 'surat', 'rajkot', 'vapi', 'valsad'],
  HR: ['haryana', 'faridabad', 'gurgaon', 'gurugram', 'sonipat', 'panchkula', 'ncr', 'chandigarh tricity'],
  HP: ['himachal'],
  JK: ['jammu', 'kashmir'],
  LA: ['ladakh'],
  JH: ['jharkhand', 'bokaro', 'dhanbad', 'singhbhum', 'jamshedpur', 'ranchi'],
  KA: ['karnataka', 'bangalore', 'bengaluru', 'belagavi', 'belgaum', 'hubli', 'mangalore', 'mysore', 'tumkur'],
  KL: ['kerala', 'calicut', 'kozhikode', 'ernakulam', 'kochi', 'kollam', 'kottayam', 'thiruvananthapuram', 'trivandrum'],
  LD: ['lakshadweep'],
  MP: ['madhya pradesh', 'bhopal', 'indore', 'gwalior', 'jabalpur'],
  MH: ['maharashtra', 'mumbai', 'pune', 'nagpur', 'nashik', 'aurangabad', 'kolhapur', 'raigad', 'satara', 'thane'],
  MN: ['manipur', 'north east', 'north-east'],
  ML: ['meghalaya', 'north east', 'north-east'],
  MZ: ['mizoram', 'north east', 'north-east'],
  NL: ['nagaland', 'north east', 'north-east'],
  TR: ['tripura', 'north east', 'north-east'],
  SK: ['sikkim', 'north east', 'north-east'],
  OD: ['odisha', 'orissa', 'angul', 'balasore', 'bhubaneshwar', 'bhubaneswar', 'cuttack', 'jajpur', 'keonjhar', 'sambalpur', 'sundergarh'],
  PY: ['pondicherry', 'puducherry'],
  PB: ['punjab', 'amritsar', 'jalandhar', 'ludhiana', 'mohali', 'chandigarh tricity'],
  RJ: ['rajasthan', 'ajmer', 'bharatpur', 'bikaner', 'jaipur', 'jodhpur', 'kota', 'udaipur'],
  TN: ['tamil nadu', 'chennai', 'coimbatore', 'erode', 'kanchipuram', 'madurai', 'namakkal', 'salem', 'thiruvallur', 'trichy', 'vellore'],
  TS: ['telangana', 'hyderabad', 'mahbubnagar', 'medak', 'nizamabad', 'secunderabad'],
  UP: ['uttar pradesh', 'east up', 'west up', 'up', 'ghaziabad', 'kanpur', 'lucknow', 'noida', 'prayagraj', 'allahabad', 'varanasi', 'ncr'],
  UK: ['uttarakhand', 'dehradun'],
  WB: ['west bengal', 'kolkata', 'darjeeling', 'bardhaman', 'medinapur', 'howrah'],
};
const ALIAS = { TG: 'TS', OR: 'OD', UA: 'UK', CT: 'CG' };          // old / alternate RTO prefixes
const RX = Object.entries(KW).map(([st, words]) => [st, new RegExp('\\b(' + words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'i')]);
const memo = new Map();

/** States a location text belongs to; empty set = not tied to a state (All, All India, North (Ref) …) */
export function locStates(loc) {
  const k = String(loc ?? '').trim();
  if (memo.has(k)) return memo.get(k);
  const out = new Set();
  if (k && !/^all\b/i.test(k)) for (const [st, rx] of RX) if (rx.test(k)) out.add(st);
  memo.set(k, out); return out;
}
/** RTO code -> state prefix ('WB-27' -> 'WB'); null if it does not look like an RTO code */
export function rtoState(code) {
  const m = String(code ?? '').trim().toUpperCase().match(/^([A-Z]{2})\s*-?\s*\d/);
  return m ? (ALIAS[m[1]] || m[1]) : null;
}
export const isRtoCol = c => /^rto\b|rto\s*code/i.test(c);
export const isLocCol = c => /^location$|^state$|^city$|^cluster$|^zone$/i.test(c);
