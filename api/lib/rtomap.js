// P-10: RTO master — which RTO codes each insurer's Location covers.
//  rto_master  : every RTO code in India (code, state, district, office)          — seeded from db/rto_master.csv
//  loc_rto     : manual overrides "insurer + location -> RTO codes" (from the RTO_Master.xlsx upload)
//  autoMap()   : works out the codes for any location without an override (state / city / "Rest of" / codes in the name)
import fs from 'node:fs';
import { locStates, STATE_NAME, normRto, stateOfCode, cleanLoc } from './geo.js';

const strip = s => String(s ?? '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9&, ]+/g, ' ').replace(/\s+/g, ' ').trim();
// location word -> words used in RTO district / office names
const CITY_ALIAS = {
  bangalore: ['bengaluru', 'bangalore'], gurgaon: ['gurugram', 'gurgaon'], calicut: ['kozhikode', 'calicut'], trichy: ['tiruchirappalli', 'trichy'],
  baroda: ['vadodara', 'baroda'], vadodara: ['vadodara'], mysore: ['mysuru', 'mysore'], mangalore: ['mangaluru', 'mangalore', 'dakshina kannada'],
  belagavi: ['belagavi', 'belgaum'], hubli: ['dharwad', 'hubballi', 'hubli'], prayagraj: ['prayagraj', 'allahabad'], allahabad: ['prayagraj', 'allahabad'],
  bhubaneswar: ['khordha', 'khurda', 'bhubaneswar'], ernakulam: ['ernakulam', 'kochi'], kochi: ['ernakulam', 'kochi'], pondicherry: ['puducherry', 'pondicherry'],
  vijayawada: ['krishna', 'ntr', 'vijayawada'], thiruvallur: ['tiruvallur', 'thiruvallur'], balasore: ['baleshwar', 'balasore'], keonjhar: ['kendujhar', 'keonjhar'],
  sundergarh: ['sundargarh', 'sundergarh'], tumkur: ['tumakuru', 'tumkur'], aurangabad: ['aurangabad', 'chhatrapati sambhajinagar'], noida: ['gautam buddha nagar', 'noida'],
  kanchipuram: ['kancheepuram', 'kanchipuram'], visakhapatnam: ['visakhapatnam'], mahbubnagar: ['mahabubnagar', 'mahbubnagar'], hyderabad: ['hyderabad', 'secunderabad'],
  jorhat: ['jorhat'], dibrugarh: ['dibrugarh'], tinsukia: ['tinsukia'], kamrup: ['kamrup', 'guwahati'], darjeeling: ['darjeeling', 'siliguri'],
  bardhaman: ['bardhaman', 'burdwan', 'asansol', 'durgapur'], medinapur: ['medinipur', 'midnapore', 'medinapur', 'tamluk', 'haldia'],
  mumbai: ['mumbai'], kolkata: ['kolkata'], chennai: ['chennai'], delhi: ['delhi'], kashmir: ['srinagar', 'anantnag', 'baramulla', 'kashmir'],
  'east singhbhum': ['east singhbhum', 'jamshedpur'], raigad: ['raigad', 'panvel', 'pen'], 'chandigarh tricity': ['chandigarh', 'sas nagar', 'mohali', 'panchkula'],
};
const NCR = { DL: null, HR: ['gurugram', 'faridabad'], UP: ['gautam buddha nagar', 'noida', 'ghaziabad'] };
const WORDS_OF_NO_PLACE = new Set(['rest', 'of', 'good', 'bad', 'ref', 'incl', 'and', '&', 'city', 'rural', 'urban', 'district', 'east', 'west', 'north', 'south', 'up', '1', '2', '3', '4', '5']);

export class RtoMaps {
  constructor(master = [], overrides = []) {
    this.master = new Map();                               // code -> {code, st, district, city, status}
    this.byState = new Map();                              // st -> [codes]
    for (const m of master) this.addCode(m);
    this.over = new Map(overrides.map(o => [o.insurer + '\u0001' + cleanLoc(o.location), o.codes && o.codes.length ? o.codes.map(normRto) : null]));   // [] / ALL = applies everywhere
    this.memo = new Map();
  }
  addCode(m) {
    const code = normRto(m.code); if (this.master.has(code)) return;
    const st = stateOfCode(code) || m.st;
    const rec = { code, st, district: String(m.district || ''), city: String(m.city || ''), status: m.status || 'active', hay: (' ' + strip(m.district) + ' ' + strip(m.city) + ' ') };
    this.master.set(code, rec);
    if (!this.byState.has(st)) this.byState.set(st, []);
    this.byState.get(st).push(code);
  }
  stateName(code) { const st = this.master.get(code)?.st || stateOfCode(code); return STATE_NAME[st] || st; }

  /** RTO codes in a city/district (words) inside the given states */
  cityCodes(words, states) {
    const out = [];
    for (const st of states) for (const code of this.byState.get(st) || []) {
      const h = this.master.get(code).hay;
      if (words.some(w => h.includes(' ' + w + ' ') || h.includes(' ' + w))) out.push(code);
    }
    return out;
  }
  cityWords(base) {
    // "Ahmedabad, Baroda & Surat" / "East & West Bardhaman" -> words of every place in the label
    const out = new Set();
    for (const part of base.toLowerCase().split(/,|&| and | incl /)) {
      const p = part.split(' ').filter(w => w && !WORDS_OF_NO_PLACE.has(w)).join(' ');
      if (!p) continue;
      if (CITY_ALIAS[p]) { CITY_ALIAS[p].forEach(w => out.add(w)); continue; }
      let hit = false;
      for (const [a, w] of Object.entries(CITY_ALIAS)) if (p === a || p.startsWith(a + ' ') || p.endsWith(' ' + a)) { w.forEach(x => out.add(x)); hit = true; }
      if (!hit) out.add(p);
    }
    return [...out];
  }

  /**
   * codes for one insurer + location.  ctx = all locations of this insurer (for "Rest of …").
   * returns { codes: [..] | null (pan-India / unknown -> applies everywhere), rule, review }
   */
  map(insurer, location, ctx = []) {
    const loc = cleanLoc(location);
    const key = insurer + '\u0001' + loc;
    if (this.over.has(key)) return { codes: this.over.get(key), rule: 'Manual (RTO master sheet)', review: false };
    if (this.memo.has(key)) return this.memo.get(key);
    const r = this.auto(insurer, loc, ctx);
    this.memo.set(key, r); return r;
  }
  auto(insurer, loc, ctx) {
    const low = loc.toLowerCase().trim();
    if (!low || low === 'all' || /^all india|pan india/.test(low)) return { codes: null, rule: 'All India', review: false };
    // 1) codes written in the name: "Hubli (KA-25&63)", "Vijayawada (AP16,17,18,19, 39 & 40)", "Varanasi (UP65)"
    const par = loc.match(/\(([^)]*\d[^)]*)\)/);
    if (par) {
      // a real state prefix + 2-3 digit number ("KA-25", "UP65"); not cluster names like "PB1", "ROM1", "WB - Rest 1"
      const m = par[1].toUpperCase().match(/\b([A-Z]{2})\s*-?\s*(\d{2,3})\b/);
      if (m && (STATE_NAME[m[1]] || ['TG', 'OR', 'UA', 'CT', 'DN'].includes(m[1]))) {
        const nums = (par[1].match(/\d+/g) || []).filter(n => n.length >= 2);
        return { codes: nums.map(n => normRto(m[1] + '-' + n)), rule: 'Codes in the location name', review: false };
      }
    }
    const states = [...locStates(loc)];
    if (!states.length) return { codes: null, rule: 'Not tied to a state (applies everywhere)', review: /\(ref\)|north|south|east|west/i.test(loc) };
    // place names inside brackets: "Gujarat (Ahmedabad & Baroda)", "Vapi (incl. Diu, Daman, Silvassa & Valsad)"
    const inner = (loc.match(/\(([^)]*)\)/) || [])[1] || '';
    const innerPlaces = /\d|^\s*(good|bad)|^\s*[a-z]{2}\s*-|ref/i.test(inner) ? '' : strip(inner);
    const cluster = /\((good|bad)|\(\s*[a-z]{2}\s*-|\bref\b|\(rom|\(up\d|\(pb\d|\(rj\d|\b[a-z]{2}\d\)|\d\)$|\s\d$/i.test(loc);
    const base = strip(loc.replace(/\(.*?\)/g, ' ')).replace(/^rest of /, '');
    const noStates = states.reduce((t, st) => t.replace(new RegExp('\\b' + strip(STATE_NAME[st]).replace(/&/g, '\\&') + '\\b', 'g'), ' '), base);
    const part = /\b(east|west|north|south|central)\b/i.test(noStates) && !/ncr/i.test(base);   // "East UP", "West UP" = part of a state
    const isRest = /^rest of /i.test(loc.trim());
    // 2) NCR
    if (/\bncr\b/i.test(loc)) {
      const codes = [];
      for (const [st, w] of Object.entries(NCR)) codes.push(...(w ? this.cityCodes(w, [st]) : (this.byState.get(st) || [])));
      return { codes, rule: 'Delhi + Gurugram, Faridabad, Noida, Ghaziabad', review: false };
    }
    // 3) whole state(s): label is only state names ("West Bengal", "Punjab & Chandigarh", "North East")
    const stateWords = states.map(s => strip(STATE_NAME[s])).join(' ');
    const leftover = base.split(' ').filter(w => w && !WORDS_OF_NO_PLACE.has(w) && !stateWords.includes(w) && !['north', 'east', 'tricity'].includes(w));
    if (!leftover.length && !isRest && !innerPlaces) {
      return { codes: states.flatMap(s => this.byState.get(s) || []), rule: 'Whole state' + (states.length > 1 ? 's' : ''), review: cluster || part };
    }
    // 4) "Rest of <state>" = state minus this insurer's own city locations in that state
    if (isRest) {
      const own = new Set();
      for (const other of ctx) {
        const o = cleanLoc(other); if (o === loc || /^rest of/i.test(o)) continue;
        if (![...locStates(o)].some(s => states.includes(s))) continue;
        const r = this.auto(insurer, o, []);
        if (r.codes && (r.rule === 'City / district' || r.rule === 'Codes in the location name')) r.codes.forEach(c => own.add(c));
      }
      const codes = states.flatMap(s => this.byState.get(s) || []).filter(c => !own.has(c));
      return { codes, rule: `Rest of state (state minus ${own.size} city RTOs of this insurer)`, review: cluster };
    }
    // 5) city / district
    const words = this.cityWords([leftover.length ? base : '', innerPlaces].filter(Boolean).join(', '));
    const codes = this.cityCodes(words, states);
    if (codes.length) return { codes, rule: 'City / district', review: cluster || (part && !CITY_ALIAS[base]) };
    return { codes: states.flatMap(s => this.byState.get(s) || []), rule: 'City not found in RTO list -> whole state', review: true };
  }
}

/** db/rto_master.csv -> [{code, st, district, city, status, source}] */
export function readMasterCsv(file) {
  const txt = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const parse = line => { const out = []; let cur = '', q = false; for (const ch of line) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
  const hdr = parse(txt[0]).map(h => h.toLowerCase());
  const ix = n => hdr.findIndex(h => h.includes(n));
  const c = { code: ix('rto code'), st: ix('state code'), district: ix('district'), city: ix('city'), status: ix('status'), source: ix('source') };
  return txt.slice(1).map(parse).map(r => ({ code: r[c.code], st: r[c.st], district: r[c.district], city: r[c.city], status: r[c.status], source: r[c.source] }));
}
