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

/* ---------- P-04: State names, Location spelling clean-up ---------- */
export const STATE_NAME = {
  AN: 'Andaman & Nicobar', AP: 'Andhra Pradesh', AR: 'Arunachal Pradesh', AS: 'Assam', BR: 'Bihar', CH: 'Chandigarh',
  CG: 'Chhattisgarh', DD: 'Daman & Diu', DN: 'Dadra & Nagar Haveli', DL: 'Delhi', GA: 'Goa', GJ: 'Gujarat', HR: 'Haryana',
  HP: 'Himachal Pradesh', JK: 'Jammu & Kashmir', LA: 'Ladakh', JH: 'Jharkhand', KA: 'Karnataka', KL: 'Kerala', LD: 'Lakshadweep',
  MP: 'Madhya Pradesh', MH: 'Maharashtra', MN: 'Manipur', ML: 'Meghalaya', MZ: 'Mizoram', NL: 'Nagaland', TR: 'Tripura',
  SK: 'Sikkim', OD: 'Odisha', PY: 'Puducherry', PB: 'Punjab', RJ: 'Rajasthan', TN: 'Tamil Nadu', TS: 'Telangana',
  UP: 'Uttar Pradesh', UK: 'Uttarakhand', WB: 'West Bengal',
};
/** state names of a location (sorted); [] = not tied to a state */
export const locStateNames = loc => [...locStates(loc)].map(s => STATE_NAME[s] || s).sort();

// same place written differently by different insurers -> one spelling in the filter list
const LOC_FIX = {
  'bhubaneshwar': 'Bhubaneswar', 'visakhapatanam': 'Visakhapatnam', 'delhi ncr': 'Delhi / NCR', 'delhi/ncr': 'Delhi / NCR',
  'ernakulam/kochi': 'Ernakulam / Kochi', 'ernakulam / kochi': 'Ernakulam / Kochi', 'kochi': 'Ernakulam / Kochi', 'ernakulam': 'Ernakulam / Kochi',
};
export function cleanLoc(v) {
  if (v == null) return v;
  let s = String(v).replace(/\s+/g, ' ').trim();
  s = s.replace(/\bRest OF\b/g, 'Rest of').replace(/\bREST OF\b/g, 'Rest of');
  return LOC_FIX[s.toLowerCase()] || s;
}

/* ---------- P-04: CC as ranges -> 3 clean choices ---------- */
export const isCcCol = c => /^cc$|cubic/i.test(c);
export const CC_BUCKETS = [['<1000', 0, 999], ['1000-1500', 1000, 1500], ['>1500', 1501, Infinity]];
export function ccRange(v) {
  const s = String(v ?? '').replace(/,/g, '').replace(/cc/ig, '').trim().toLowerCase(); let m;
  if ((m = s.match(/^(?:<=?|below|upto|up to)\s*(\d+)/))) return [0, s.startsWith('<=') ? +m[1] : +m[1] - 1];
  if ((m = s.match(/^(?:>=?|above)\s*(\d+)/))) return [s.startsWith('>=') ? +m[1] : +m[1] + 1, Infinity];
  if ((m = s.match(/^(\d+)\s*(?:-|to)\s*(\d+)/))) return [+m[1], +m[2]];
  return null;
}
/** the clean CC choices a row's CC value belongs to ('>1000' -> ['1000-1500','>1500']) */
export function ccOptions(v) {
  if (String(v ?? '').trim().toLowerCase() === 'all') return ['All'];
  const r = ccRange(v); if (!r) return [String(v)];
  return CC_BUCKETS.filter(([, a, b]) => r[0] <= b && a <= r[1]).map(x => x[0]);
}
