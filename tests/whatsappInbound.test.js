// Unit tests for shared/whatsappInbound.js (which workspace does a WhatsApp webhook event belong to?) and
// shared/crossWorkspaceOptOut.js (typed STOP / START on the shared number). No database and no network: every model is an
// in-memory fake handed in through the `deps` seam, so nothing here can touch real data.
const inbound = require('../shared/whatsappInbound');
const { optOutEverywhere, startEverywhere, STOP_REPLY, START_REPLY_REINSTATED, START_REPLY_NOT_REINSTATED } = require('../shared/crossWorkspaceOptOut');

// ---- a tiny in-memory model: enough of the mongoose query API used by the modules under test ----
const getPath = (doc, path) => path.split('.').reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), doc);
const eq = (a, b) => (a && b && typeof a === 'object' && typeof b === 'object' ? String(a) === String(b) : a === b);
function matches(doc, filter) {
  return Object.entries(filter || {}).every(([path, cond]) => {
    const v = getPath(doc, path);
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond) && !(cond._bsontype) && Object.keys(cond).some((k) => k.startsWith('$'))) {
      return Object.entries(cond).every(([op, arg]) => {
        if (op === '$in') return arg.some((x) => eq(x, v));
        if (op === '$ne') return !eq(v, arg);
        if (op === '$gte') return v !== undefined && v >= arg;
        if (op === '$exists') return arg ? v !== undefined : v === undefined;
        throw new Error(`fake model: unsupported operator ${op}`);
      });
    }
    return eq(v, cond);
  });
}
function fakeModel(rows, { log } = {}) {
  const query = (list, one) => {
    let out = list; let lim = null; let sortSpec = null;
    const q = {
      select() { return q; },
      lean() { return q; },
      limit(n) { lim = n; return q; },
      sort(spec) { sortSpec = spec; return q; },
      then(res, rej) {
        let r = out.slice();
        if (sortSpec) { const [k, dir] = Object.entries(sortSpec)[0]; r.sort((a, b) => ((a[k] > b[k]) - (a[k] < b[k])) * dir); }
        if (lim !== null) r = r.slice(0, lim);
        return Promise.resolve(one ? (r[0] || null) : r).then(res, rej);
      },
    };
    return q;
  };
  return {
    rows,
    findOne: (f) => { if (log) log.push(['findOne', f]); return query(rows.filter((r) => matches(r, f)), true); },
    find: (f) => { if (log) log.push(['find', f]); return query(rows.filter((r) => matches(r, f)), false); },
    findById: (id) => { if (log) log.push(['findById', id]); return query(rows.filter((r) => eq(r._id, id)), true); },
    distinct: async (field) => [...new Set(rows.map((r) => r[field]).filter((x) => x !== undefined))],
  };
}

const W_OLD = 'a00000000000000000000001'; // the oldest workspace
const W_A = 'a00000000000000000000002';
const W_B = 'a00000000000000000000003';
const ID = (n) => `b${String(n).padStart(23, '0')}`; // a 24-hex id
const T0 = Date.UTC(2026, 9, 26, 12, 0, 0);
const hours = (h) => new Date(T0 - h * 3600 * 1000);

let clock; let logs; let log; let sleeps;
function mkDeps(data = {}) {
  const calls = [];
  const models = {
    Workspace: fakeModel(data.workspaces || [
      { _id: W_OLD, createdAt: hours(1000) },
      { _id: W_A, createdAt: hours(500), whatsapp: { phoneId: 'PHONE_A' } },
      { _id: W_B, createdAt: hours(400) },
    ], { log: calls }),
    CampaignMessage: fakeModel(data.campaignMessages || [], { log: calls }),
    WhatsAppMessage: fakeModel(data.whatsappMessages || [], { log: calls }),
    Customer: fakeModel(data.customers || [], { log: calls }),
    Settings: fakeModel(data.settings || [], { log: calls }),
    Promotion: fakeModel(data.promotions || [], { log: calls }),
    Flow: fakeModel(data.flows || [], { log: calls }),
    MessageNode: fakeModel(data.nodes || [], { log: calls }),
    Product: fakeModel(data.products || [], { log: calls }),
    Service: fakeModel(data.services || [], { log: calls }),
    TimeSlot: fakeModel(data.slots || [], { log: calls }),
  };
  return { models, now: () => clock, log: (level, ...a) => logs.push([level, ...a]), calls, sleep: async (ms) => { sleeps.push(ms); } };
}
const value = (phoneId) => ({ metadata: phoneId === undefined ? undefined : { phone_number_id: phoneId } });
const text = (from, body = 'hello') => ({ from, id: 'wamid.IN', type: 'text', text: { body } });
const tap = (from, payload, ctxId) => ({ from, id: 'wamid.IN', type: 'button', button: { payload, text: 'x' }, ...(ctxId ? { context: { id: ctxId } } : {}) });
const reply = (from, id, ctxId) => ({ from, id: 'wamid.IN', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: 'x' } }, ...(ctxId ? { context: { id: ctxId } } : {}) });
const sid = (r) => String(r.workspaceId);

beforeEach(() => {
  clock = T0; logs = []; sleeps = [];
  inbound._resetForTests();
  delete process.env.WA_PHONE_ID;
});

describe('parsePayload / payloadOf', () => {
  test('every payload prefix that embeds a document id', () => {
    const id = ID(7);
    const cases = {
      [`promo:${id}:opt_in:1`]: ['Promotion', 'promotion'], [`promotest:${id}:opt_in:1`]: ['Promotion', 'promotion'],
      [`promo_${id}`]: ['Promotion', 'promotion'], [`optout_${id}`]: ['Promotion', 'promotion'],
      [`flowbrowse_${id}_${ID(8)}`]: ['Flow', 'flow'], [`flownoshow_${id}_${ID(8)}`]: ['Service', 'service'],
      [`rebook_${id}_${ID(8)}`]: ['Service', 'service'], [`carouselsvc_${id}_${ID(8)}`]: ['Service', 'service'],
      [`msgnode_${id}_2`]: ['MessageNode', 'node'], [`consent_yes_${id}`]: ['Customer', 'customer'], [`consent_no_${id}`]: ['Customer', 'customer'],
      [`cart_${id}`]: ['Product', 'product'], [`variant_${id}_3`]: ['Product', 'product'],
      [`slot_${id}`]: ['TimeSlot', 'slot'], [`reslot_${id}`]: ['TimeSlot', 'slot'], [`paylater_${id}`]: ['TimeSlot', 'slot'],
    };
    for (const [payload, [model, kind]] of Object.entries(cases)) {
      const p = inbound.parsePayload(payload);
      expect(p).toMatchObject({ id, rule: { model, kind } });
    }
  });
  test('no id, a short / non-hex id, an unknown prefix or a non-string give null', () => {
    for (const bad of ['promo_', 'promo_123', `promo_${'z'.repeat(24)}`, 'checkout', 'more_5_x', '', null, undefined, 42]) expect(inbound.parsePayload(bad)).toBeNull();
  });
  test('payloadOf reads template buttons, button replies and list replies', () => {
    expect(inbound.payloadOf(tap('1', 'promo_x'))).toBe('promo_x');
    expect(inbound.payloadOf(reply('1', 'optout_y'))).toBe('optout_y');
    expect(inbound.payloadOf({ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'slot_z' } } })).toBe('slot_z');
    expect(inbound.payloadOf(text('1'))).toBe('');
    expect(inbound.payloadOf(null)).toBe('');
  });
});

describe('R1: the customer\'s own phone number', () => {
  test('a message and a status on a workspace\'s own phone id belong to that workspace', async () => {
    const deps = mkDeps();
    expect(await inbound.resolveEventWorkspace({ value: value('PHONE_A'), message: text('966500000001') }, deps)).toEqual({ workspaceId: W_A, rule: 'R1_phone_id' });
    expect(await inbound.resolveEventWorkspace({ value: value('PHONE_A'), status: { id: 'wamid.X', status: 'sent' } }, deps)).toEqual({ workspaceId: W_A, rule: 'R1_phone_id' });
  });
  test('R1 wins over a wamid / payload / customer that points at another workspace', async () => {
    const deps = mkDeps({ campaignMessages: [{ wamid: 'wamid.B', workspaceId: W_B }], customers: [{ phone: '966500000001', workspaceId: W_B }] });
    const out = await inbound.resolveEventWorkspace({ value: value('PHONE_A'), message: tap('966500000001', `promo_${ID(1)}`, 'wamid.B') }, deps);
    expect(out).toEqual({ workspaceId: W_A, rule: 'R1_phone_id' });
  });
  test('the answer is cached for 60 seconds, then looked up again', async () => {
    const deps = mkDeps();
    const lookups = () => deps.calls.filter(([m, f]) => m === 'findOne' && f && f['whatsapp.phoneId'] === 'PHONE_A').length;
    await inbound.resolveEventWorkspace({ value: value('PHONE_A'), message: text('1') }, deps);
    await inbound.resolveEventWorkspace({ value: value('PHONE_A'), message: text('1') }, deps);
    expect(lookups()).toBe(1);
    clock += 59 * 1000;
    await inbound.resolveEventWorkspace({ value: value('PHONE_A'), message: text('1') }, deps);
    expect(lookups()).toBe(1);
    clock += 2 * 1000;
    await inbound.resolveEventWorkspace({ value: value('PHONE_A'), message: text('1') }, deps);
    expect(lookups()).toBe(2);
  });
  test('an unknown phone id is cached negatively for a short time only (a number may have just been saved), and invalidatePhoneId clears it', async () => {
    const deps = mkDeps();
    const lookups = () => deps.calls.filter(([m, f]) => m === 'findOne' && f && f['whatsapp.phoneId'] === 'NEW_PHONE').length;
    await inbound.resolveEventWorkspace({ value: value('NEW_PHONE'), message: text('1') }, deps);
    await inbound.resolveEventWorkspace({ value: value('NEW_PHONE'), message: text('1') }, deps);
    expect(lookups()).toBe(1);
    deps.models.Workspace.rows.push({ _id: W_B, whatsapp: { phoneId: 'NEW_PHONE' }, createdAt: hours(400) });
    inbound.invalidatePhoneId('NEW_PHONE');
    expect(await inbound.resolveEventWorkspace({ value: value('NEW_PHONE'), message: text('1') }, deps)).toEqual({ workspaceId: W_B, rule: 'R1_phone_id' });
    expect(lookups()).toBe(2);
    inbound.invalidatePhoneId();
  });
  test('the platform phone id (WA_PHONE_ID, or the built-in default) is never looked up as a customer\'s number', async () => {
    const deps = mkDeps();
    await inbound.resolveEventWorkspace({ value: value('1032683093271618'), message: text('1') }, deps);
    process.env.WA_PHONE_ID = 'MY_PLATFORM_ID';
    await inbound.resolveEventWorkspace({ value: value('MY_PLATFORM_ID'), message: text('1') }, deps);
    expect(deps.calls.filter(([, f]) => f && f['whatsapp.phoneId'] !== undefined)).toHaveLength(0);
  });
  test('an unknown phone id logs a (throttled) warning and is then attributed by its content, oldest workspace when it has none', async () => {
    const deps = mkDeps();
    const out = await inbound.resolveEventWorkspace({ value: value('999'), message: text('966500000009') }, deps);
    expect(out).toEqual({ workspaceId: W_OLD, rule: 'R2_oldest_no_customer' });
    await inbound.resolveEventWorkspace({ value: value('999'), message: text('966500000009') }, deps);
    expect(logs.filter(([l]) => l === 'warn')).toHaveLength(1);
    clock += 11 * 60 * 1000;
    await inbound.resolveEventWorkspace({ value: value('999'), message: text('966500000009') }, deps);
    expect(logs.filter(([l]) => l === 'warn')).toHaveLength(2);
  });
});

describe('R2: statuses', () => {
  test('a status goes to the workspace of the CampaignMessage with that wamid', async () => {
    const deps = mkDeps({ campaignMessages: [{ wamid: 'wamid.1', workspaceId: W_B }] });
    expect(await inbound.resolveEventWorkspace({ value: value(), status: { id: 'wamid.1' } }, deps)).toEqual({ workspaceId: W_B, rule: 'R2_status_wamid' });
  });
  test('...else a manual send (WhatsAppMessage)', async () => {
    const deps = mkDeps({ whatsappMessages: [{ wamid: 'wamid.2', workspaceId: W_A }] });
    expect(await inbound.resolveEventWorkspace({ value: value(), status: { id: 'wamid.2' } }, deps)).toEqual({ workspaceId: W_A, rule: 'R2_status_wamid' });
  });
  test('a legacy row with no workspaceId is attributed through its customer', async () => {
    const deps = mkDeps({ campaignMessages: [{ wamid: 'wamid.3', customer: ID(5) }], customers: [{ _id: ID(5), workspaceId: W_B, phone: '1' }] });
    expect(sid(await inbound.resolveEventWorkspace({ value: value(), status: { id: 'wamid.3' } }, deps))).toBe(W_B);
  });
  test('an unknown wamid, a missing id, or a legacy row with no customer: the oldest workspace', async () => {
    const deps = mkDeps({ campaignMessages: [{ wamid: 'wamid.4' }] });
    for (const status of [{ id: 'wamid.nope' }, {}, { id: 'wamid.4' }]) {
      expect(await inbound.resolveEventWorkspace({ value: value(), status }, deps)).toMatchObject({ workspaceId: W_OLD });
    }
  });
});

describe('R2: replies and button taps', () => {
  test('context.id resolves through CampaignMessage, then WhatsAppMessage', async () => {
    const deps = mkDeps({ campaignMessages: [{ wamid: 'wamid.C', workspaceId: W_B }], whatsappMessages: [{ wamid: 'wamid.M', workspaceId: W_A }] });
    expect(await inbound.resolveEventWorkspace({ value: value(), message: text('1') }, deps)).toMatchObject({ rule: 'R2_oldest_no_customer' });
    expect(await inbound.resolveEventWorkspace({ value: value(), message: { ...text('1'), context: { id: 'wamid.C' } } }, deps)).toEqual({ workspaceId: W_B, rule: 'R2_context_wamid' });
    expect(await inbound.resolveEventWorkspace({ value: value(), message: { ...text('1'), context: { id: 'wamid.M' } } }, deps)).toEqual({ workspaceId: W_A, rule: 'R2_context_wamid' });
  });
  test('context.id wins over the payload id', async () => {
    const deps = mkDeps({ campaignMessages: [{ wamid: 'wamid.C', workspaceId: W_B }], promotions: [{ _id: ID(1), workspaceId: W_A }] });
    expect(sid(await inbound.resolveEventWorkspace({ value: value(), message: tap('1', `promo_${ID(1)}`, 'wamid.C') }, deps))).toBe(W_B);
  });
  test('an unknown context.id falls through to the payload', async () => {
    const deps = mkDeps({ promotions: [{ _id: ID(1), workspaceId: W_A }] });
    expect(await inbound.resolveEventWorkspace({ value: value(), message: tap('1', `promo_${ID(1)}`, 'wamid.nope') }, deps)).toEqual({ workspaceId: W_A, rule: 'R2_payload_promotion' });
  });
  test.each([
    ['promo:ID:opt_in:1', 'promotions', 'R2_payload_promotion'], ['promo_ID', 'promotions', 'R2_payload_promotion'], ['optout_ID', 'promotions', 'R2_payload_promotion'],
    ['flowbrowse_ID_ID', 'flows', 'R2_payload_flow'], ['msgnode_ID_1', 'nodes', 'R2_payload_node'], ['consent_yes_ID', 'customers', 'R2_payload_customer'],
    ['consent_no_ID', 'customers', 'R2_payload_customer'], ['cart_ID', 'products', 'R2_payload_product'], ['carouselsvc_ID_ID', 'services', 'R2_payload_service'],
    ['flownoshow_ID_ID', 'services', 'R2_payload_service'], ['slot_ID', 'slots', 'R2_payload_slot'],
  ])('payload %s -> the workspace of that document (%s)', async (template, collection, rule) => {
    const id = ID(11);
    const payload = template.replace(/ID/g, id);
    const deps = mkDeps({ [collection]: [{ _id: id, workspaceId: W_B }] });
    // a template button and a button reply carry the same ids
    expect(await inbound.resolveEventWorkspace({ value: value(), message: tap('1', payload) }, deps)).toEqual({ workspaceId: W_B, rule });
    expect(await inbound.resolveEventWorkspace({ value: value(), message: reply('1', payload) }, deps)).toEqual({ workspaceId: W_B, rule });
  });
  test('optout_<id> of a MessageNode (flow bridge) resolves through the node when it is not a promotion', async () => {
    const deps = mkDeps({ nodes: [{ _id: ID(2), workspaceId: W_A }] });
    expect(await inbound.resolveEventWorkspace({ value: value(), message: tap('1', `optout_${ID(2)}`) }, deps)).toEqual({ workspaceId: W_A, rule: 'R2_payload_promotion' });
  });
  test('a payload whose document does not exist (or has no workspace) falls through to the phone rule', async () => {
    const deps = mkDeps({ promotions: [{ _id: ID(1) }], customers: [{ phone: '966500000001', workspaceId: W_B }] });
    for (const payload of [`promo_${ID(1)}`, `promo_${ID(99)}`, 'promo_notanid']) {
      expect(await inbound.resolveEventWorkspace({ value: value(), message: tap('966500000001', payload) }, deps)).toEqual({ workspaceId: W_B, rule: 'R2_customer_single' });
    }
  });
});

describe('R2: typed text and everything else -> customer by phone', () => {
  test('exactly one workspace has this customer', async () => {
    const deps = mkDeps({ customers: [{ phone: '966500000001', workspaceId: W_B }] });
    expect(await inbound.resolveEventWorkspace({ value: value(), message: text('966500000001') }, deps)).toEqual({ workspaceId: W_B, rule: 'R2_customer_single' });
  });
  test('several rows in the SAME workspace still count as one workspace', async () => {
    const deps = mkDeps({ customers: [{ phone: '966500000001', workspaceId: W_B }, { phone: '+966500000001', workspaceId: W_B }] });
    expect(await inbound.resolveEventWorkspace({ value: value(), message: text('966500000001') }, deps)).toEqual({ workspaceId: W_B, rule: 'R2_customer_single' });
  });
  test('a number saved in a national spelling (05...) matches the international sender', async () => {
    const deps = mkDeps({ customers: [{ phone: '0500000001', workspaceId: W_A }] });
    expect(sid(await inbound.resolveEventWorkspace({ value: value(), message: text('966500000001') }, deps))).toBe(W_A);
    // and the country code another workspace configured counts too
    inbound._resetForTests(); // the country-code list is cached for a minute
    const deps2 = mkDeps({ customers: [{ phone: '0412345678', workspaceId: W_B }], settings: [{ defaultCountryCode: '+61' }] });
    expect(sid(await inbound.resolveEventWorkspace({ value: value(), message: text('61412345678') }, deps2))).toBe(W_B);
  });
  test('erased customers and customers without a workspace never count', async () => {
    const deps = mkDeps({ customers: [{ phone: '966500000001', workspaceId: W_B, deletedAt: new Date() }, { phone: '966500000001' }] });
    expect(await inbound.resolveEventWorkspace({ value: value(), message: text('966500000001') }, deps)).toMatchObject({ workspaceId: W_OLD, rule: 'R2_oldest_no_customer' });
  });
  test('several workspaces: the one with the most recent outbound CampaignMessage within 72 hours', async () => {
    const customers = [{ phone: '966500000001', workspaceId: W_A }, { phone: '966500000001', workspaceId: W_B }, { phone: '966500000001', workspaceId: W_OLD }];
    const deps = mkDeps({ customers, campaignMessages: [
      { phone: '966500000001', workspaceId: W_A, createdAt: hours(60), status: 'sent' },
      { phone: '966500000001', workspaceId: W_B, createdAt: hours(10), status: 'delivered' },
      { phone: '966500000001', workspaceId: W_OLD, createdAt: hours(2), status: 'failed' }, // never delivered: does not count
    ] });
    expect(await inbound.resolveEventWorkspace({ value: value(), message: text('966500000001') }, deps)).toEqual({ workspaceId: W_B, rule: 'R2_customer_recent_outbound' });
  });
  test('several workspaces, nothing sent within 72 hours: the OLDEST of them', async () => {
    const deps = mkDeps({
      customers: [{ phone: '966500000001', workspaceId: W_B }, { phone: '966500000001', workspaceId: W_A }],
      campaignMessages: [{ phone: '966500000001', workspaceId: W_B, createdAt: hours(80), status: 'sent' }],
    });
    expect(await inbound.resolveEventWorkspace({ value: value(), message: text('966500000001') }, deps)).toEqual({ workspaceId: W_A, rule: 'R2_customer_oldest_of' });
  });
  test('a message sent to the same phone by a workspace that does not have the customer is ignored', async () => {
    const deps = mkDeps({
      customers: [{ phone: '966500000001', workspaceId: W_A }, { phone: '966500000001', workspaceId: W_B }],
      campaignMessages: [{ phone: '966500000001', workspaceId: W_OLD, createdAt: hours(1), status: 'sent' }],
    });
    expect(sid(await inbound.resolveEventWorkspace({ value: value(), message: text('966500000001') }, deps))).toBe(W_A);
  });
  test('nobody has this phone: the oldest workspace (the inbox then creates the customer there, as always)', async () => {
    expect(await inbound.resolveEventWorkspace({ value: value(), message: text('966500000777') }, mkDeps())).toEqual({ workspaceId: W_OLD, rule: 'R2_oldest_no_customer' });
  });
});

describe('R3 and failures: never throws, falls back to the oldest workspace', () => {
  test('nothing usable in the event', async () => {
    const deps = mkDeps();
    for (const args of [{}, { value: {} }, { message: {} }, undefined, null]) {
      expect(await inbound.resolveEventWorkspace(args, deps)).toEqual({ workspaceId: W_OLD, rule: 'R3_oldest' });
    }
  });
  test('a model that keeps throwing -> rule R3_error (the caller must NOT file the message under the oldest workspace), after three tries', async () => {
    const deps = mkDeps();
    let attempts = 0;
    deps.models.CampaignMessage.findOne = () => { attempts += 1; throw new Error('db down'); };
    const out = await inbound.resolveEventWorkspace({ value: value(), status: { id: 'wamid.1' } }, deps);
    expect(out).toEqual({ workspaceId: W_OLD, rule: 'R3_error' });
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([150, 400]); // short, bounded waits between the tries
    expect(logs.some(([l, m]) => l === 'warn' && /db down/.test(m) && /NOT attributed/.test(m))).toBe(true);
  });
  test('a lookup that fails once and then works is attributed normally: the customer\'s message does not land in the oldest workspace', async () => {
    const deps = mkDeps({ campaignMessages: [{ wamid: 'wamid.mine', workspaceId: W_B }] });
    const real = deps.models.CampaignMessage.findOne;
    let attempts = 0;
    deps.models.CampaignMessage.findOne = (f) => { attempts += 1; if (attempts === 1) throw new Error('throttled'); return real(f); };
    const out = await inbound.resolveEventWorkspace({ value: value(), message: { ...text('966500000001'), context: { id: 'wamid.mine' } } }, deps);
    expect(out).toEqual({ workspaceId: W_B, rule: 'R2_context_wamid' });
    expect(sleeps).toEqual([150]);
  });
  test('a typed message whose customer lookup keeps failing is R3_error too (not "no customer": that would be the oldest workspace)', async () => {
    const deps = mkDeps();
    deps.models.Customer.find = () => { throw new Error('db down'); };
    const out = await inbound.resolveEventWorkspace({ value: value(), message: text('966500000001') }, deps);
    expect(out.rule).toBe('R3_error');
  });
  test('even the oldest-workspace lookup failing does not throw: workspaceId undefined', async () => {
    const deps = mkDeps();
    deps.models.CampaignMessage.findOne = () => { throw new Error('db down'); };
    deps.models.Workspace.findOne = () => { throw new Error('db down'); };
    expect(await inbound.resolveEventWorkspace({ value: value(), status: { id: 'x' } }, deps)).toEqual({ workspaceId: undefined, rule: 'R3_error' });
  });
  test('an empty database (no workspace at all) answers undefined, like the old lookup did', async () => {
    const deps = mkDeps({ workspaces: [] });
    expect(await inbound.resolveEventWorkspace({ value: value(), message: text('1') }, deps)).toMatchObject({ workspaceId: undefined });
  });
  test('a caller that already has the oldest workspace id passes it in and no oldest query is made', async () => {
    const deps = mkDeps();
    const out = await inbound.resolveEventWorkspace({ value: value(), message: text('966500000777'), oldestWorkspaceId: 'a0000000000000000000ffff' }, deps);
    expect(out.workspaceId).toBe('a0000000000000000000ffff');
    expect(deps.calls.filter(([m, f]) => m === 'findOne' && Object.keys(f || {}).length === 0)).toHaveLength(0);
  });
});

describe('resolveStatusGroups', () => {
  test('statuses are grouped per workspace in order of first appearance, with ONE batched lookup per collection', async () => {
    const deps = mkDeps({
      campaignMessages: [{ wamid: 'w1', workspaceId: W_B }, { wamid: 'w2', workspaceId: W_A }, { wamid: 'w3', workspaceId: W_B }],
      whatsappMessages: [{ wamid: 'w4', workspaceId: W_A }],
    });
    const statuses = [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }, { id: 'w4' }, { id: 'unknown' }];
    const groups = await inbound.resolveStatusGroups({ value: value(), statuses }, deps);
    expect(groups.map((g) => [String(g.workspaceId), g.statuses.map((s) => s.id)])).toEqual([[W_B, ['w1', 'w3']], [W_A, ['w2', 'w4']], [W_OLD, ['unknown']]]);
    expect(deps.calls.filter(([m, f]) => m === 'find' && f.wamid)).toHaveLength(2); // one CampaignMessage.find + one WhatsAppMessage.find
  });
  test('the whole change belongs to a customer\'s own phone id (R1)', async () => {
    const deps = mkDeps();
    const groups = await inbound.resolveStatusGroups({ value: value('PHONE_A'), statuses: [{ id: 'a' }, { id: 'b' }] }, deps);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ workspaceId: W_A, rule: 'R1_phone_id' });
    expect(groups[0].statuses).toHaveLength(2);
  });
  test('an unknown status joins the group of the oldest workspace when that workspace also owns others', async () => {
    const deps = mkDeps({ campaignMessages: [{ wamid: 'w1', workspaceId: W_OLD }] });
    const groups = await inbound.resolveStatusGroups({ value: value(), statuses: [{ id: 'w1' }, { id: 'zzz' }] }, deps);
    expect(groups).toHaveLength(1);
    expect(groups[0].statuses.map((s) => s.id)).toEqual(['w1', 'zzz']);
  });
  test('no statuses -> no groups; a lookup that keeps failing -> one R3_error group (the caller applies none of them), no throw', async () => {
    const deps = mkDeps();
    expect(await inbound.resolveStatusGroups({ value: value(), statuses: [] }, deps)).toEqual([]);
    let attempts = 0;
    deps.models.CampaignMessage.find = () => { attempts += 1; throw new Error('db down'); };
    const groups = await inbound.resolveStatusGroups({ value: value(), statuses: [{ id: 'a' }] }, deps);
    expect(groups).toEqual([{ workspaceId: W_OLD, rule: 'R3_error', statuses: [{ id: 'a' }] }]);
    expect(attempts).toBe(3);
  });
  test('a status lookup that fails once and then works is grouped normally, and a retry never double-counts a status', async () => {
    const deps = mkDeps({ campaignMessages: [{ wamid: 'w1', workspaceId: W_B }, { wamid: 'w2', workspaceId: W_A }] });
    const real = deps.models.CampaignMessage.find;
    let attempts = 0;
    deps.models.CampaignMessage.find = (f) => { attempts += 1; if (attempts === 1) throw new Error('throttled'); return real(f); };
    const groups = await inbound.resolveStatusGroups({ value: value(), statuses: [{ id: 'w1' }, { id: 'w2' }] }, deps);
    expect(groups.map((g) => [String(g.workspaceId), g.statuses.map((s) => s.id)])).toEqual([[W_B, ['w1']], [W_A, ['w2']]]);
  });
});

describe('customerKnownInWorkspace', () => {
  test('known in any spelling, unknown, other workspace, and fail-open on an error', async () => {
    const deps = mkDeps({ customers: [{ phone: '0500000001', workspaceId: W_A }, { phone: '966500000002', workspaceId: W_B }] });
    expect(await inbound.customerKnownInWorkspace(W_A, '966500000001', deps)).toBe(true);
    expect(await inbound.customerKnownInWorkspace(W_A, '966500000002', deps)).toBe(false);
    expect(await inbound.customerKnownInWorkspace(W_A, '966500000555', deps)).toBe(false);
    deps.models.Customer.findOne = () => { throw new Error('db down'); };
    expect(await inbound.customerKnownInWorkspace(W_A, '966500000001', deps)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('crossWorkspaceOptOut (typed STOP / START on the shared number)', () => {
  const PHONE = '966500000001';
  // ownNumber: ids of the workspaces that send from a WhatsApp number of their own (the fake answers the query of usingOwnNumber)
  function mkOpt({ customers, optedOutOf = [], ownNumber = [] } = {}) {
    const events = [];
    const sent = [];
    const samePhone = [];
    const model = fakeModel(customers);
    const deps = {
      Customer: model,
      Workspace: {
        find: jest.fn((filter) => {
          const asked = ((filter && filter._id && filter._id.$in) || []).map(String);
          const rows = ownNumber.filter((id) => asked.includes(String(id))).map((id) => ({ _id: id }));
          const q = { select() { return q; }, lean: async () => rows };
          return q;
        }),
      },
      consent: {
        withdrawMarketingConsent: jest.fn(async (a) => { events.push(['withdraw', String(a.workspaceId), a]); }),
        reinstateMarketingConsent: jest.fn(async (a) => { events.push(['reinstate', String(a.workspaceId), a]); return a.customer.marketingConsent === true || a.customer.optedOut === true; }),
      },
      optOutSamePhone: jest.fn(async (a) => { samePhone.push(a); }),
      send: jest.fn(async (to, body) => { sent.push([to, body]); }),
      log: jest.fn(),
      phoneDeps: { models: { Settings: fakeModel([]) }, now: () => clock },
    };
    return { deps, events, sent, samePhone };
  }
  const cust = (workspaceId, over = {}) => ({ _id: `c-${workspaceId}`, phone: PHONE, workspaceId, ...over });

  test('STOP: opted out in EVERY workspace that has the phone, one reply; the event workspace first', async () => {
    const { deps, events, sent, samePhone } = mkOpt({ customers: [cust(W_A), cust(W_B), cust(W_OLD)] });
    const out = await optOutEverywhere({ from: PHONE, workspaceId: W_B, messageText: 'STOP', wamid: 'wamid.S1' }, deps);
    expect(events.map((e) => [e[0], e[1]])).toEqual([['withdraw', W_B], ['withdraw', W_OLD], ['withdraw', W_A]]);
    expect(samePhone.map((a) => String(a.workspaceId))).toEqual([W_B, W_OLD, W_A]);
    expect(samePhone[0]).toMatchObject({ from: PHONE, exceptCustomerId: `c-${W_B}`, method: 'whatsapp_stop_command' });
    expect(sent).toEqual([[PHONE, STOP_REPLY]]);
    expect(out).toMatchObject({ workspaces: 3, optedOut: 3, failed: 0, replied: true });
    // several workspaces: evidence is recorded, the inbound id is made unique per workspace (ConsentEvent.inboundWamid is unique)
    const ev = events.map((e) => e[2].evidence);
    expect(ev.every((e) => e.messageText === 'STOP')).toBe(true);
    expect(new Set(ev.map((e) => e.inboundWamid)).size).toBe(3);
    expect(ev[0].inboundWamid).toBe(`wamid.S1@${W_B}`);
    expect(events[0][2].source).toBe('WhatsApp STOP reply (shared WhatsApp number)');
  });
  test('STOP with ONE workspace is exactly the single-workspace behaviour: same args, no evidence, same source', async () => {
    const { deps, events, sent, samePhone } = mkOpt({ customers: [cust(W_OLD)] });
    await optOutEverywhere({ from: PHONE, workspaceId: W_OLD, messageText: 'STOP', wamid: 'wamid.S1' }, deps);
    expect(deps.consent.withdrawMarketingConsent).toHaveBeenCalledTimes(1);
    expect(events[0][2]).toEqual({ customer: expect.objectContaining({ _id: `c-${W_OLD}` }), method: 'whatsapp_stop_command', source: 'WhatsApp STOP reply', workspaceId: W_OLD });
    expect(samePhone).toEqual([{ workspaceId: W_OLD, from: PHONE, exceptCustomerId: `c-${W_OLD}`, method: 'whatsapp_stop_command', source: 'WhatsApp STOP reply' }]);
    expect(sent).toEqual([[PHONE, STOP_REPLY]]);
  });
  test('STOP from a phone nobody has: no write, the same reply (as before); the event workspace still gets the same-number sweep', async () => {
    const { deps, events, sent, samePhone } = mkOpt({ customers: [] });
    await optOutEverywhere({ from: PHONE, workspaceId: W_OLD }, deps);
    expect(events).toEqual([]);
    expect(samePhone).toHaveLength(1);
    expect(samePhone[0].exceptCustomerId == null).toBe(true);
    expect(sent).toEqual([[PHONE, STOP_REPLY]]);
  });
  test('STOP: an erased customer and a customer of another phone are untouched', async () => {
    const { deps, events } = mkOpt({ customers: [cust(W_A, { deletedAt: new Date() }), cust(W_B, { phone: '966500000002' })] });
    await optOutEverywhere({ from: PHONE, workspaceId: W_OLD }, deps);
    expect(events).toEqual([]);
  });
  test('STOP: a failure in one workspace does not stop the others, and no success reply is sent', async () => {
    const { deps, events, sent } = mkOpt({ customers: [cust(W_A), cust(W_B)] });
    deps.consent.withdrawMarketingConsent.mockImplementationOnce(async () => { throw new Error('write failed'); });
    const out = await optOutEverywhere({ from: PHONE, workspaceId: W_A }, deps);
    expect(events.map((e) => e[1])).toEqual([W_B]);
    expect(out).toMatchObject({ failed: 1, optedOut: 1, replied: false });
    expect(sent).toEqual([]);
    expect(deps.log).toHaveBeenCalled();
  });
  test('STOP: a redelivered message (duplicate inbound id) is skipped for that workspace without an error', async () => {
    const { deps, sent } = mkOpt({ customers: [cust(W_A), cust(W_B)] });
    deps.consent.withdrawMarketingConsent.mockImplementationOnce(async () => { throw Object.assign(new Error('E11000'), { code: 11000 }); });
    const out = await optOutEverywhere({ from: PHONE, workspaceId: W_A, wamid: 'wamid.S1' }, deps);
    expect(out.failed).toBe(0);
    expect(sent).toHaveLength(1);
  });
  test('STOP: a redelivery of a STOP that was already recorded everywhere sends no second reply', async () => {
    const { deps, sent } = mkOpt({ customers: [cust(W_A), cust(W_B)] });
    deps.consent.withdrawMarketingConsent.mockImplementation(async (x) => ({ customer: x.customer, duplicate: true }));
    const out = await optOutEverywhere({ from: PHONE, workspaceId: W_A, wamid: 'wamid.S1' }, deps);
    expect(out).toMatchObject({ optedOut: 0, duplicates: 2, failed: 0, replied: false });
    expect(sent).toEqual([]);
  });
  test('START: a redelivery that was already recorded sends no second reply', async () => {
    const { deps, sent } = mkOpt({ customers: [cust(W_A, { optedOut: true })] });
    deps.consent.reinstateMarketingConsent.mockImplementation(async (x) => ({ customer: x.customer, duplicate: true }));
    const out = await startEverywhere({ from: PHONE, workspaceId: W_A, wamid: 'wamid.T1' }, deps);
    expect(out).toMatchObject({ reinstated: 0, duplicates: 1, replied: false });
    expect(sent).toEqual([]);
  });
  test('STOP: a failed reply is ignored', async () => {
    const { deps } = mkOpt({ customers: [cust(W_OLD)] });
    deps.send.mockRejectedValueOnce(new Error('whatsapp down'));
    await expect(optOutEverywhere({ from: PHONE, workspaceId: W_OLD }, deps)).resolves.toMatchObject({ replied: false, optedOut: 1 });
  });
  test('STOP: a failing phone lookup still processes the event workspace, but is not confirmed (other businesses may have been missed; the customer can send STOP again)', async () => {
    const { deps, events, sent } = mkOpt({ customers: [cust(W_OLD)] });
    const real = deps.Customer.find;
    deps.Customer.find = () => { throw new Error('db down'); };
    const out = await optOutEverywhere({ from: PHONE, workspaceId: W_OLD }, deps);
    deps.Customer.find = real;
    expect(events.map((e) => e[1])).toEqual([W_OLD]);
    expect(out).toMatchObject({ optedOut: 1, failed: 1, replied: false });
    expect(sent).toEqual([]);
  });
  test('STOP: a workspace that sends from a number of its OWN is not reached (the STOP was addressed to the shared number); the event workspace always is', async () => {
    const { deps, events, sent, samePhone } = mkOpt({ customers: [cust(W_A), cust(W_B), cust(W_OLD)], ownNumber: [W_B] });
    const out = await optOutEverywhere({ from: PHONE, workspaceId: W_OLD, messageText: 'STOP', wamid: 'wamid.S1' }, deps);
    expect(events.map((e) => [e[0], e[1]])).toEqual([['withdraw', W_OLD], ['withdraw', W_A]]);
    expect(samePhone.map((a) => String(a.workspaceId))).toEqual([W_OLD, W_A]);
    expect(out).toMatchObject({ workspaces: 2, optedOut: 2, failed: 0, replied: true });
    expect(sent).toEqual([[PHONE, STOP_REPLY]]);
    // the check asks about the other businesses only, never the event workspace
    expect(deps.Workspace.find.mock.calls[0][0]._id.$in.map(String).sort()).toEqual([W_A, W_B]);
  });
  test('STOP: the event workspace is processed even when it has a number of its own (it was attributed by the router)', async () => {
    const { deps, events } = mkOpt({ customers: [cust(W_OLD), cust(W_A)], ownNumber: [W_OLD, W_A] });
    await optOutEverywhere({ from: PHONE, workspaceId: W_OLD }, deps);
    expect(events.map((e) => e[1])).toEqual([W_OLD]);
  });
  test('STOP: a failing own-number check is a failed lookup: the event workspace is processed, nothing is confirmed', async () => {
    const { deps, events, sent } = mkOpt({ customers: [cust(W_OLD), cust(W_A)] });
    deps.Workspace.find.mockImplementation(() => { throw new Error('db down'); });
    const out = await optOutEverywhere({ from: PHONE, workspaceId: W_OLD }, deps);
    expect(events.map((e) => e[1])).toEqual([W_OLD]);
    expect(out).toMatchObject({ failed: 1, replied: false });
    expect(sent).toEqual([]);
  });

  test('START: a fresh opt-in for the business whose conversation this is, with its evidence; the "welcome back" reply', async () => {
    const { deps, events, sent } = mkOpt({ customers: [cust(W_A, { optedOut: true }), cust(W_B, { optedOut: true }), cust(W_OLD, { marketingConsent: true })] });
    const out = await startEverywhere({ from: PHONE, workspaceId: W_A, messageText: 'START', wamid: 'wamid.T1', signature: 'valid' }, deps);
    expect(events.map((e) => [e[0], e[1]])).toEqual([['reinstate', W_A]]); // never another business, even one that a STOP opted out
    expect(events[0][2]).toMatchObject({ method: 'whatsapp_start_command', source: 'WhatsApp START reply', signature: 'valid' });
    expect(events[0][2].evidence).toEqual({ messageText: 'START', inboundWamid: `wamid.T1@${W_A}`, signature: 'valid' });
    expect(out).toMatchObject({ workspaces: 1, reinstated: 1, replied: true });
    expect(sent).toEqual([[PHONE, START_REPLY_REINSTATED]]);
  });
  test('START never re-opts the person in at another business: nobody can ask a business they never spoke to', async () => {
    const { deps, events, sent } = mkOpt({ customers: [cust(W_A, { optedOut: true }), { _id: 'spelled', phone: '+966500000001', workspaceId: W_B, optedOut: true }, cust(W_OLD, { optedOut: true })] });
    const out = await startEverywhere({ from: PHONE, workspaceId: W_OLD }, deps);
    expect(events.map((e) => [e[0], e[1]])).toEqual([['reinstate', W_OLD]]);
    expect(deps.consent.reinstateMarketingConsent).toHaveBeenCalledTimes(1);
    expect(out.reinstated).toBe(1);
    expect(sent).toEqual([[PHONE, START_REPLY_REINSTATED]]);
  });
  test('START typed to the shared number does not address a workspace that has a number of its OWN (the reply is the "Got it" one)', async () => {
    const { deps, events, sent } = mkOpt({ customers: [cust(W_A, { optedOut: true })], ownNumber: [W_A] });
    const out = await startEverywhere({ from: PHONE, workspaceId: W_A }, deps);
    expect(events).toEqual([]);
    expect(deps.consent.reinstateMarketingConsent).not.toHaveBeenCalled();
    expect(out.reinstated).toBe(0);
    expect(sent).toEqual([[PHONE, START_REPLY_NOT_REINSTATED]]);
  });
  test('START: a failing own-number check is a failure: nothing is confirmed', async () => {
    const { deps, sent } = mkOpt({ customers: [cust(W_A, { optedOut: true })] });
    deps.Workspace.find.mockImplementation(() => { throw new Error('db down'); });
    const out = await startEverywhere({ from: PHONE, workspaceId: W_A }, deps);
    expect(out).toMatchObject({ failed: 1, replied: false });
    expect(sent).toEqual([]);
  });
  test('START where nobody was opted out: the existing "Got it" reply and no write in other businesses', async () => {
    const { deps, events, sent } = mkOpt({ customers: [cust(W_A), cust(W_B, { marketingConsent: true })] });
    deps.consent.reinstateMarketingConsent.mockResolvedValue(false);
    await startEverywhere({ from: PHONE, workspaceId: W_A }, deps);
    expect(deps.consent.reinstateMarketingConsent).toHaveBeenCalledTimes(1); // only the event workspace, as the single-workspace code did
    expect(events).toEqual([]);
    expect(sent).toEqual([[PHONE, START_REPLY_NOT_REINSTATED]]);
  });
  test('START with ONE workspace is exactly the single-workspace behaviour: no evidence', async () => {
    const { deps } = mkOpt({ customers: [cust(W_OLD, { marketingConsent: true })] });
    await startEverywhere({ from: PHONE, workspaceId: W_OLD, wamid: 'wamid.T1' }, deps);
    expect(deps.consent.reinstateMarketingConsent).toHaveBeenCalledWith({ customer: expect.objectContaining({ _id: `c-${W_OLD}` }), method: 'whatsapp_start_command', source: 'WhatsApp START reply', workspaceId: W_OLD });
  });
  test('START from an opted-out customer of ONE business is a fresh opt-in: its evidence (typed words, message id) is kept', async () => {
    const { deps } = mkOpt({ customers: [cust(W_OLD, { optedOut: true })] });
    await startEverywhere({ from: PHONE, workspaceId: W_OLD, messageText: 'START', wamid: 'wamid.T9' }, deps);
    expect(deps.consent.reinstateMarketingConsent).toHaveBeenCalledWith(expect.objectContaining({
      customer: expect.objectContaining({ _id: `c-${W_OLD}` }), evidence: { messageText: 'START', inboundWamid: `wamid.T9@${W_OLD}` },
    }));
  });
  test('START from an unknown phone: "Got it" reply, no write', async () => {
    const { deps, sent } = mkOpt({ customers: [] });
    await startEverywhere({ from: PHONE, workspaceId: W_OLD }, deps);
    expect(deps.consent.reinstateMarketingConsent).not.toHaveBeenCalled();
    expect(sent).toEqual([[PHONE, START_REPLY_NOT_REINSTATED]]);
  });
  test('START: a failed write is never answered with a success message', async () => {
    const { deps, sent } = mkOpt({ customers: [cust(W_A, { optedOut: true })] });
    deps.consent.reinstateMarketingConsent.mockRejectedValueOnce(new Error('write failed'));
    const out = await startEverywhere({ from: PHONE, workspaceId: W_A }, deps);
    expect(out).toMatchObject({ failed: 1, replied: false });
    expect(sent).toEqual([]);
  });

  test('the reply texts are the exact texts the single-workspace branch sends', () => {
    expect(STOP_REPLY).toBe("You've been unsubscribed from promotional messages. Reply START to opt back in anytime.");
    expect(START_REPLY_REINSTATED).toBe("You're subscribed to promotional messages again. Welcome back! \u{1F389}");
    expect(START_REPLY_NOT_REINSTATED).toBe('Got it — you won\'t receive promotional messages unless you opt in.');
    const server = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
    for (const t of [STOP_REPLY, START_REPLY_REINSTATED, START_REPLY_NOT_REINSTATED]) expect(server).toContain(t);
  });
});
