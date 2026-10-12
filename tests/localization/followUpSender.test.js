// Unit tests for the Arabic follow-up sender (shared/localization/followUpSender.js). Every model is an
// in-memory fake that honours the filters it is given, the transport is a jest.fn (nothing reaches WhatsApp),
// and the rules (flowFollowUps) and value builder (flowBridge.collectValues) are the REAL ones.
const fs = require('fs');
const path = require('path');
const { id, fakeModel } = require('./helpers/flowFakes');
const { sendLocalizedFollowUp } = require('../../shared/localization/followUpSender');
const { hashSource } = require('../../shared/localization/flowFollowUps');
const { extractWamid } = require('../../shared/localization/transport');

const LRM = '\u{200E}';
const WS = id(0xa1);
const OTHER_WS = id(0xb2);
const PROMOTION = id(10);
const FLOW = id(1);
const NODE = id(101);
const ENTRY = id(100);
const CUSTOMER = id(7);
const ENROLLMENT = id(50);
const BOOKING = id(60);
const SERVICE = id(70);
const PHONE = '966500000001';

const button = (position, label) => ({ position, label, nextAction: { type: 'end_flow' } });
const nodeDoc = (over = {}) => ({
  _id: NODE, workspaceId: WS, ownerType: 'promotion', ownerId: PROMOTION, isEntryNode: false,
  bodyText: 'Great choice {{1}}! Your order is on its way.', buttons: [button(0, 'Track it'), button(1, 'Done')], ...over,
});
const rowDoc = (node = nodeDoc(), over = {}) => ({
  _id: id(800), workspaceId: WS, messageNodeId: NODE, language: 'ar', body: 'اختيار رائع يا {name}! طلبك في الطريق.',
  buttons: [{ position: 0, text: 'تتبع الطلب' }, { position: 1, text: 'تم' }],
  reviewStatus: 'reviewed', sourceHash: hashSource(node), contentVersion: 1, ...over,
});
const customerDoc = (over = {}) => ({ _id: CUSTOMER, workspaceId: WS, firstname: 'Sara', lastname: 'Ahmed', loyaltyPoints: 120, optedOut: false, ...over });

function makeWorld(data = {}) {
  const has = (key, fallback) => (key in data ? data[key] : fallback);
  return {
    settings: {
      killSwitchOn: jest.fn(() => !!data.kill),
      isArabicEnabled: jest.fn(async () => data.enabled !== false),
      getSettings: jest.fn(async () => ({ defaultCustomerLanguage: data.merchantDefault || 'en' })),
    },
    transport: {
      sendText: jest.fn(async () => has('textResult', { messages: [{ id: 'wamid.TEXT' }] })),
      sendButtons: jest.fn(async () => has('buttonsResult', { messages: [{ id: 'wamid.BTN' }] })),
      extractWamid,
    },
    CustomerLanguage: fakeModel(has('languages', [{ workspaceId: WS, customerId: CUSTOMER, language: 'ar' }])),
    LocalizedFlowNode: fakeModel(has('rows', [rowDoc()])),
    MessageNode: fakeModel(has('nodes', [nodeDoc()])),
    Promotion: fakeModel(has('promotions', [{ _id: PROMOTION, workspaceId: WS, name: 'Summer Sale', customerType: 'cash', scope: 'products', entryNodeId: ENTRY }])),
    Flow: fakeModel(has('flows', [{ _id: FLOW, workspaceId: WS, triggerType: 'booking_no_show' }])),
    FlowEnrollment: fakeModel(has('enrollments', [{ _id: ENROLLMENT, flow: FLOW, customer: CUSTOMER, sourceModel: 'Booking', sourceRef: BOOKING }])),
    Booking: fakeModel(has('bookings', [{ _id: BOOKING, workspaceId: WS, serviceId: SERVICE }])),
    Service: fakeModel(has('services', [{ _id: SERVICE, workspaceId: WS, name: 'Facial' }])),
    ProductTranslation: fakeModel(has('translations', [])),
    Settings: fakeModel(has('settings', [{ workspaceId: WS, merchantName: 'Glow Spa' }])),
    getCurrency: jest.fn(async () => data.currency || 'SAR'), // flowBridge reads the merchant currency through its deps
    ops: {
      resolvePromoItems: jest.fn(async () => has('items', [{ _id: id(30), name: 'Blue T-Shirt', basePrice: 45 }])),
      buildPromoEntryNodeParams: jest.fn(async (c, p, items) => [c.firstname, items[0].name, '45.00 SAR', p.name]),
    },
    log: jest.fn(),
  };
}

const run = (deps, over = {}) => sendLocalizedFollowUp({ workspaceId: WS, to: PHONE, node: nodeDoc(), customer: customerDoc(), enrollmentId: ENROLLMENT, ...over }, deps);
const flowWorld = (rowBody, rowOver = {}, nodeOver = {}) => {
  const node = nodeDoc({ ownerType: 'flow', ownerId: FLOW, ...nodeOver });
  return makeWorld({ nodes: [node], rows: [rowDoc(node, { body: rowBody, ...rowOver })] });
};

describe('sendLocalizedFollowUp: the Arabic send', () => {
  test('interactive buttons in NODE order with the positional tap ids and the Arabic labels; the first name is isolated from the Arabic text', async () => {
    const deps = makeWorld();
    const out = await run(deps);
    expect(deps.transport.sendButtons).toHaveBeenCalledTimes(1);
    expect(deps.transport.sendButtons).toHaveBeenCalledWith(PHONE, {
      body: `اختيار رائع يا ${LRM}Sara${LRM}! طلبك في الطريق.`,
      buttons: [{ id: `msgnode_${NODE}_0`, title: 'تتبع الطلب' }, { id: `msgnode_${NODE}_1`, title: 'تم' }],
    });
    expect(deps.transport.sendText).not.toHaveBeenCalled();
    expect(out.language).toBe('ar');
    expect(out.result.messages[0].id).toBe('wamid.BTN');
    expect(out.error).toBeUndefined();
  });
  test('a node without buttons is a plain text message (4096 limit)', async () => {
    const node = nodeDoc({ buttons: [] });
    const deps = makeWorld({ nodes: [node], rows: [rowDoc(node, { buttons: [], body: 'شكرًا لك يا {name}' })] });
    const out = await run(deps, { node });
    expect(deps.transport.sendText).toHaveBeenCalledWith(PHONE, `شكرًا لك يا ${LRM}Sara${LRM}`);
    expect(deps.transport.sendButtons).not.toHaveBeenCalled();
    expect(out.result.messages[0].id).toBe('wamid.TEXT');
  });
  test('buttons follow the NODE order even when the node stores them out of order, with non-contiguous positions', async () => {
    const node = nodeDoc({ buttons: [button(2, 'Later'), button(0, 'Now')] });
    const deps = makeWorld({ nodes: [node], rows: [rowDoc(node, { buttons: [{ position: 0, text: 'الآن' }, { position: 2, text: 'لاحقًا' }] })] });
    await run(deps, { node });
    expect(deps.transport.sendButtons.mock.calls[0][1].buttons).toEqual([
      { id: `msgnode_${NODE}_2`, title: 'لاحقًا' },
      { id: `msgnode_${NODE}_0`, title: 'الآن' },
    ]);
  });
  test('uses the TARGET node and customer given, not anything else: the destination is exactly `to`', async () => {
    const deps = makeWorld();
    await run(deps, { to: '966511111111' });
    expect(deps.transport.sendButtons.mock.calls[0][0]).toBe('966511111111');
  });
  test('the merchant default (Arabic) applies to a customer with no stored language; a stored English customer stays English', async () => {
    const unknown = makeWorld({ languages: [], merchantDefault: 'ar' });
    expect((await run(unknown)).language).toBe('ar');
    const english = makeWorld({ languages: [{ workspaceId: WS, customerId: CUSTOMER, language: 'en' }], merchantDefault: 'ar' });
    expect(await run(english)).toBeNull();
    expect(english.transport.sendButtons).not.toHaveBeenCalled();
  });
  test('an unknown stored language falls to the merchant default (English here)', async () => {
    expect(await run(makeWorld({ languages: [{ workspaceId: WS, customerId: CUSTOMER, language: 'unknown' }] }))).toBeNull();
  });
});

describe('sendLocalizedFollowUp: values', () => {
  const bodyOf = (deps) => deps.transport.sendButtons.mock.calls[0][1].body;
  test('a missing first name gets the Arabic fallback, never the English "there"; a phone-like name counts as none', async () => {
    for (const firstname of [undefined, '', '   ', '+966 50 000 0001', '٩٦٦٥٠٠٠٠٠٠٠١']) {
      const deps = makeWorld();
      await run(deps, { customer: customerDoc({ firstname }) });
      expect(bodyOf(deps)).toBe('اختيار رائع يا عميلنا العزيز! طلبك في الطريق.');
    }
  });
  test('an Arabic first name is not wrapped; a Latin one is; emoji and mixed names pass through', async () => {
    const arabic = makeWorld();
    await run(arabic, { customer: customerDoc({ firstname: 'سارة' }) });
    expect(bodyOf(arabic)).toBe('اختيار رائع يا سارة! طلبك في الطريق.');
    const emoji = makeWorld();
    await run(emoji, { customer: customerDoc({ firstname: 'Sara \u{1F338}' }) });
    expect(bodyOf(emoji)).toContain('Sara \u{1F338}');
    const mixed = makeWorld();
    await run(mixed, { customer: customerDoc({ firstname: 'Mohammed محمد' }) });
    expect(bodyOf(mixed)).toContain('Mohammed محمد');
  });
  test('a 100-character name that pushes the rendered text over 1024 code points -> null (English), nothing sent', async () => {
    const node = nodeDoc();
    const long = 'ا'.repeat(960);
    const deps = makeWorld({ rows: [rowDoc(node, { body: `${long} {name}` })] });
    expect(await run(deps, { customer: customerDoc({ firstname: 'N'.repeat(100) }) })).toBeNull();
    expect(deps.transport.sendButtons).not.toHaveBeenCalled();
    const ok = makeWorld({ rows: [rowDoc(node, { body: `${long} {name}` })] });
    expect((await run(ok, { customer: customerDoc({ firstname: 'Sara' }) })).language).toBe('ar');
  });
  test('{points} stays in Western digits (isolated from the Arabic text); zero and missing balances read 0', async () => {
    for (const [loyaltyPoints, text] of [[120, '120'], [0, '0'], [undefined, '0'], [11, '11']]) {
      const deps = flowWorld('لديك {points} نقطة يا {name}');
      deps.Flow.docs[0].triggerType = 'post_purchase_points';
      await run(deps, { node: deps.MessageNode.docs[0], customer: customerDoc({ loyaltyPoints }) });
      expect(deps.transport.sendButtons.mock.calls[0][1].body).toBe(`لديك ${LRM}${text}${LRM} نقطة يا ${LRM}Sara${LRM}`);
    }
  });
  test('R3-04: the follow-up follows the same bidi rule (no mark next to a bold / italic * or _; the default marks elsewhere)', async () => {
    const MARK_NEXT_TO_FORMAT = /[*_]\u{200E}|\u{200E}[*_]/u;
    const deps = flowWorld('يا *{name}* لديك _{points}_ نقطة، شكراً {name} *رصيدك {points}*');
    deps.Flow.docs[0].triggerType = 'post_purchase_points';
    await run(deps, { node: deps.MessageNode.docs[0], customer: customerDoc({ loyaltyPoints: 120 }) });
    const body = deps.transport.sendButtons.mock.calls[0][1].body;
    expect(body).toBe(`يا *Sara* لديك _120_ نقطة، شكراً ${LRM}Sara${LRM} *رصيدك 120*`);
    expect(body).not.toMatch(MARK_NEXT_TO_FORMAT);
    process.env.LOCALIZATION_WRAP_SESSION_LRM = '0';
    try {
      const off = flowWorld('يا {name}');
      await run(off);
      expect(off.transport.sendButtons.mock.calls[0][1].body).toBe('يا Sara');
    } finally { delete process.env.LOCALIZATION_WRAP_SESSION_LRM; }
  });
  test('promotion {item}, {price} (SAR, written in Arabic like 45.00 ر.س) and {promo_name} come from the promotion, the reviewed Arabic item name first', async () => {
    const node = nodeDoc();
    const row = rowDoc(node, { body: 'عرض {promo_name}: {item} بسعر {price}' });
    const plain = makeWorld({ rows: [row] });
    await run(plain);
    expect(plain.transport.sendButtons.mock.calls[0][1].body).toBe(`عرض ${LRM}Summer Sale${LRM}: ${LRM}Blue T-Shirt${LRM} بسعر 45.00 ر.س`);
    const translated = makeWorld({ rows: [row], translations: [{ workspaceId: WS, kind: 'product', refId: id(30), language: 'ar', status: 'reviewed', name: 'قميص أزرق' }] });
    await run(translated);
    expect(translated.transport.sendButtons.mock.calls[0][1].body).toContain(`${'قميص أزرق'} بسعر`);
    const draftOnly = makeWorld({ rows: [row], translations: [{ workspaceId: WS, kind: 'product', refId: id(30), language: 'ar', status: 'draft', name: 'مسودة' }] });
    await run(draftOnly);
    expect(draftOnly.transport.sendButtons.mock.calls[0][1].body).not.toContain('مسودة');
  });
  test('a promotion price nobody can compute (cash promotion without items) -> null, never a hole', async () => {
    const node = nodeDoc();
    const deps = makeWorld({ rows: [rowDoc(node, { body: 'السعر {price}' })], items: [] });
    expect(await run(deps)).toBeNull();
    expect(deps.transport.sendButtons).not.toHaveBeenCalled();
  });
  test('{service} comes enrollment -> booking -> service inside the workspace; a reviewed Arabic service name wins', async () => {
    const plain = flowWorld('تعال لحجز {service} يا {name}');
    await run(plain, { node: plain.MessageNode.docs[0] });
    expect(plain.transport.sendButtons.mock.calls[0][1].body).toBe(`تعال لحجز ${LRM}Facial${LRM} يا ${LRM}Sara${LRM}`);
    const translated = flowWorld('تعال لحجز {service} يا {name}');
    translated.ProductTranslation.docs.push({ workspaceId: WS, kind: 'service', refId: SERVICE, language: 'ar', status: 'reviewed', name: 'جلسة عناية' });
    await run(translated, { node: translated.MessageNode.docs[0] });
    expect(translated.transport.sendButtons.mock.calls[0][1].body).toContain('جلسة عناية');
    expect(translated.Booking.findOne).toHaveBeenCalledWith({ _id: BOOKING, workspaceId: WS });
  });
  test('{service} fallbacks: unnamed service -> Arabic fallback; no booking / foreign flow / non-booking enrollment / no enrollment -> null', async () => {
    const unnamed = flowWorld('حجز {service}');
    unnamed.Service.docs[0].name = '';
    await run(unnamed, { node: unnamed.MessageNode.docs[0] });
    expect(unnamed.transport.sendButtons.mock.calls[0][1].body).toContain('خدمتك');

    const noBooking = flowWorld('حجز {service}');
    noBooking.Booking.docs.length = 0;
    expect(await run(noBooking, { node: noBooking.MessageNode.docs[0] })).toBeNull();

    const foreignFlow = flowWorld('حجز {service}');
    foreignFlow.Flow.docs[0].workspaceId = OTHER_WS;
    expect(await run(foreignFlow, { node: foreignFlow.MessageNode.docs[0] })).toBeNull();

    const order = flowWorld('حجز {service}');
    order.FlowEnrollment.docs[0].sourceModel = 'Order';
    expect(await run(order, { node: order.MessageNode.docs[0] })).toBeNull();

    const none = flowWorld('حجز {service}');
    expect(await run(none, { node: none.MessageNode.docs[0], enrollmentId: undefined })).toBeNull();
    expect(await run(none, { node: none.MessageNode.docs[0], enrollmentId: { $ne: null } })).toBeNull();
    expect(none.FlowEnrollment.findOne).not.toHaveBeenCalled();

    const foreignBooking = flowWorld('حجز {service}');
    foreignBooking.Booking.docs[0].workspaceId = OTHER_WS;
    expect(await run(foreignBooking, { node: foreignBooking.MessageNode.docs[0] })).toBeNull();
  });
  test('the enrollment lookup is skipped when the text does not use {service}', async () => {
    const deps = makeWorld();
    await run(deps);
    expect(deps.FlowEnrollment.findOne).not.toHaveBeenCalled();
  });
});

describe('sendLocalizedFollowUp returns null (the English message) unless everything lines up', () => {
  test('flag off / kill switch: only the cached flag is consulted', async () => {
    for (const data of [{ enabled: false }, { kill: true }]) {
      const deps = makeWorld(data);
      expect(await run(deps)).toBeNull();
      for (const model of ['CustomerLanguage', 'LocalizedFlowNode', 'MessageNode', 'Promotion', 'Flow']) expect(deps[model].findOne).not.toHaveBeenCalled();
      expect(deps.transport.sendButtons).not.toHaveBeenCalled();
    }
  });
  test('no Arabic row, a draft, a stale row, a row with issues', async () => {
    const node = nodeDoc();
    expect(await run(makeWorld({ rows: [] }))).toBeNull();
    expect(await run(makeWorld({ rows: [rowDoc(node, { reviewStatus: 'draft' })] }))).toBeNull();
    expect(await run(makeWorld({ rows: [rowDoc(node, { sourceHash: 'old' })] }))).toBeNull();
    expect(await run(makeWorld({ rows: [rowDoc(node, { sourceHash: undefined })] }))).toBeNull();
    expect(await run(makeWorld({ rows: [rowDoc(node, { body: 'يا {points}' })] }))).toBeNull(); // unknown field for a promotion
    expect(await run(makeWorld({ rows: [rowDoc(node, { buttons: [{ position: 0, text: 'تتبع' }] })] }))).toBeNull();
    expect(await run(makeWorld({ rows: [rowDoc(node, { buttons: [{ position: 0, text: 'نعم' }, { position: 1, text: 'نعم' }] })] }))).toBeNull();
  });
  test('the English text changed after the Arabic was reviewed: stale -> English until re-reviewed', async () => {
    const deps = makeWorld();
    deps.MessageNode.docs[0].bodyText = 'Updated offer {{1}}';
    expect(await run(deps)).toBeNull();
    expect(deps.transport.sendButtons).not.toHaveBeenCalled();
  });
  test('an entry node, an opted-out customer, a node of another workspace, a node nobody owns', async () => {
    expect(await run(makeWorld(), { node: nodeDoc({ isEntryNode: true }) })).toBeNull();
    const entryInDb = makeWorld({ nodes: [nodeDoc({ isEntryNode: true })] });
    expect(await run(entryInDb)).toBeNull(); // the handler's copy says follow-up, the database says entry: the database wins
    expect(await run(makeWorld(), { customer: customerDoc({ optedOut: true }) })).toBeNull();
    expect(await run(makeWorld({ nodes: [nodeDoc({ workspaceId: OTHER_WS })] }))).toBeNull();
    expect(await run(makeWorld({ nodes: [] }))).toBeNull();
    const legacy = makeWorld({ nodes: [nodeDoc({ workspaceId: undefined })], promotions: [] });
    expect(await run(legacy)).toBeNull();
  });
  test('a row of another workspace for the same node is not used', async () => {
    const deps = makeWorld({ rows: [rowDoc(nodeDoc(), { workspaceId: OTHER_WS })] });
    expect(await run(deps)).toBeNull();
  });
  test('garbage arguments never throw', async () => {
    const deps = makeWorld();
    for (const args of [undefined, null, {}, 42, { workspaceId: WS }, { workspaceId: 'x', to: PHONE, node: nodeDoc(), customer: customerDoc() },
      { workspaceId: { $ne: null }, to: PHONE, node: nodeDoc(), customer: customerDoc() }, { workspaceId: WS, to: '', node: nodeDoc(), customer: customerDoc() },
      { workspaceId: WS, to: PHONE, node: null, customer: customerDoc() }, { workspaceId: WS, to: PHONE, node: nodeDoc(), customer: null },
      { workspaceId: WS, to: PHONE, node: { bodyText: 'x' }, customer: customerDoc() }]) {
      await expect(sendLocalizedFollowUp(args, deps)).resolves.toBeNull();
    }
    expect(deps.transport.sendButtons).not.toHaveBeenCalled();
  });
  test.each(['CustomerLanguage', 'LocalizedFlowNode', 'MessageNode', 'Promotion', 'ProductTranslation'])('a failing %s query returns null (English) and is logged', async (model) => {
    const deps = makeWorld({ rows: [rowDoc(nodeDoc(), { body: 'يا {name} {item}' })] });
    deps[model].findOne = jest.fn(() => { throw new Error(`${model} down`); });
    expect(await run(deps)).toBeNull();
    expect(deps.log).toHaveBeenCalled();
    expect(deps.transport.sendButtons).not.toHaveBeenCalled();
  });
  test('a failing settings read returns null; a missing logger cannot make it throw', async () => {
    const deps = makeWorld();
    deps.settings.getSettings = jest.fn(async () => { throw new Error('x'); });
    delete deps.log;
    await expect(run(deps)).resolves.toBeNull();
  });
  test('realDeps failing to load a model still returns null', async () => {
    jest.resetModules();
    jest.doMock('../../models/LocalizedFlowNode', () => { throw new Error('model load failed'); });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const isolated = require('../../shared/localization/followUpSender');
    await expect(isolated.sendLocalizedFollowUp({ workspaceId: WS, to: PHONE, node: nodeDoc(), customer: customerDoc() })).resolves.toBeNull();
    spy.mockRestore();
    jest.dontMock('../../models/LocalizedFlowNode');
    jest.resetModules();
  });
});

describe('sendLocalizedFollowUp: send failures and result shapes', () => {
  test('a failed send is OUR answer ({ error }), sent once, never retried and never followed by English', async () => {
    const deps = makeWorld();
    deps.transport.sendButtons = jest.fn(async () => { throw new Error('Recipient not in allowed list'); });
    const out = await run(deps);
    expect(out.language).toBe('ar');
    expect(out.error).toBeInstanceOf(Error);
    expect(out.error.message).toBe('Recipient not in allowed list');
    expect(out.result).toBeUndefined();
    expect(deps.transport.sendButtons).toHaveBeenCalledTimes(1);
    expect(deps.transport.sendText).not.toHaveBeenCalled();
  });
  test.each([['a string', 'boom'], ['undefined', undefined], ['an object', { message: 'obj' }], ['null', null]])('%s thrown by the transport still becomes an Error', async (_, thrown) => {
    const deps = makeWorld();
    deps.transport.sendButtons = jest.fn(async () => { throw thrown; });
    const out = await run(deps);
    expect(out.error).toBeInstanceOf(Error);
    expect(out.error.message.length).toBeGreaterThan(0);
  });
  test('an axios-style envelope is normalised so result.messages[0].id is the wamid', async () => {
    const deps = makeWorld({ buttonsResult: { data: { messages: [{ id: 'wamid.AX' }] }, status: 200 } });
    expect((await run(deps)).result.messages[0].id).toBe('wamid.AX');
  });
  test('a dry-run result keeps its fake wamid; a result without one gives an empty message list, not a failure', async () => {
    const dry = makeWorld({ buttonsResult: { dryRun: true, messages: [{ id: 'dryrun.1.abc' }] } });
    const out = await run(dry);
    expect(out.result.dryRun).toBe(true);
    expect(out.result.messages[0].id).toBe('dryrun.1.abc');
    const odd = makeWorld({ buttonsResult: undefined });
    odd.transport.sendButtons = jest.fn(async () => undefined);
    const outOdd = await run(odd);
    expect(outOdd.error).toBeUndefined();
    expect(outOdd.result.messages).toEqual([]);
  });
});

describe('sendLocalizedFollowUp is read-only and workspace-scoped', () => {
  test('no model is ever written and every workspace-owned query carries this workspace id', async () => {
    const deps = makeWorld();
    await run(deps);
    for (const model of ['CustomerLanguage', 'LocalizedFlowNode', 'MessageNode', 'Promotion', 'Flow', 'FlowEnrollment', 'Booking', 'Service', 'ProductTranslation', 'Settings']) {
      expect(deps[model].create).not.toHaveBeenCalled();
      expect(deps[model].findOneAndUpdate).not.toHaveBeenCalled();
    }
    for (const model of ['CustomerLanguage', 'LocalizedFlowNode', 'Promotion', 'Settings']) {
      for (const [filter] of deps[model].findOne.mock.calls) expect(filter.workspaceId).toBe(WS);
    }
  });
  test('the module never writes, never deletes and never calls WhatsApp directly', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'localization', 'followUpSender.js'), 'utf8');
    expect(source.match(/(?<!Object)\.create\(|\.save\(|updateOne|updateMany|findOneAndUpdate|deleteOne|deleteMany|\.remove\(|axios|waPost/)).toBeNull();
  });
  test('server.js carries exactly one call of the follow-up sender, inside try/catch, before the English send', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
    expect(source.split('followUpSender').length - 1).toBe(1);
    const i = source.indexOf('followUpSender');
    const english = source.indexOf('await sendMessageNodeFollowUp(from, targetNode', i);
    expect(english).toBeGreaterThan(i);
    expect(source.slice(i - 80, i)).toMatch(/try \{ localizedFollowUp = await require\(/);
    expect(source).toMatch(/if \(localizedFollowUp && localizedFollowUp\.error\) throw localizedFollowUp\.error;/);
  });
});
