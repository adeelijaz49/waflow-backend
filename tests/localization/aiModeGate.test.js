// The human-approval gate of the Arabic AI Mode agent (spec §6: "nothing sends
// without explicit confirmation, in any language; a misunderstood Arabic request
// must never result in a send"). Everything is faked: the Claude client replays a
// script, the tools are jest.fn recorders over the REAL tool definitions, the
// session store is in memory. No network, no database, no Stripe.
const { createAiModeAgent } = require('../../shared/localization/aiMode/agent');
const { createToolBridge, ACTION_TOOL_NAMES, DRAFT_WRITE_TOOL_NAMES, READ_TOOL_NAMES } = require('../../shared/localization/aiMode/tools');
const F = require('./helpers/aiModeFakes');

const { IDS, text, toolUse, response } = F;
const NOW = new Date('2026-10-11T18:30:00Z');
const WS = '65f2a1b3c4d5e6f708192a01';
const OTHER_WS = '65f2a1b3c4d5e6f708192a02';

function build({ responses = [response([text('ok')])], results, lookups, sessions, options } = {}) {
  const client = F.scriptedClient(responses);
  const rec = F.recorderRegistry(results);
  const log = jest.fn();
  const agent = createAiModeAgent({
    client, tools: rec.registry, sessions, lookups: lookups === undefined ? F.makeLookups() : lookups, now: () => NOW, log, options,
  });
  return { agent, client, log, ...rec };
}
const newSession = (extra = {}) => ({ sessionId: 'session-aaaa-1111', messages: [], pendingAction: null, ...extra });

const sendPromotion = (id = 'tu_1', input = { promotionId: IDS.promo, customerIds: [IDS.c1, IDS.c2] }) => toolUse(id, 'send_promotion', input);

describe('allow-list snapshot of the gated tools', () => {
  const { registry } = F.recorderRegistry();
  const bridge = createToolBridge(registry);

  test('the registry flags exactly the five known action tools (a registry change must force a review)', () => {
    const flagged = bridge.listTools().filter((t) => t.isAction).map((t) => t.name).sort();
    expect(flagged).toEqual([...ACTION_TOOL_NAMES].sort());
    expect(ACTION_TOOL_NAMES).toEqual(['send_promotion', 'send_test_message', 'send_loyalty_reminders', 'activate_flow', 'refund_order']);
  });

  test('every registry tool is classified as read / draft-write / action, and nothing else is', () => {
    const names = bridge.listTools().map((t) => t.name).sort();
    const classified = [...READ_TOOL_NAMES, ...DRAFT_WRITE_TOOL_NAMES, ...ACTION_TOOL_NAMES].sort();
    expect(names).toEqual(classified);
    expect(names).toHaveLength(20);
    expect(new Set(classified).size).toBe(20); // disjoint
  });

  test('isAction is fail-safe: truthy flags gate, unknown names are not actions and cannot run', () => {
    const registry2 = F.makeRegistry([{ name: 'odd', isAction: 1 }, { name: 'plain', isAction: false }]);
    const b = createToolBridge(registry2);
    expect(b.isAction('odd')).toBe(true);
    expect(b.isAction('plain')).toBe(false);
    expect(b.isAction('nope')).toBe(false);
    expect(b.isAction(undefined)).toBe(false);
    expect(b.getTool({ toString: () => 'odd' })).toBeUndefined();
  });
});

describe('proposing: an action tool never runs inside the loop', () => {
  const validCalls = [
    ['send_promotion', { promotionId: IDS.promo, customerIds: [IDS.c1] }],
    ['send_test_message', { promotionId: IDS.promo, phone: '966501234567' }],
    ['send_loyalty_reminders', {}],
    ['activate_flow', { flowId: IDS.flow }],
    ['refund_order', { orderId: IDS.order }],
  ];

  test.each(validCalls)('%s becomes a pending action and its run() is never called', async (name, input) => {
    const { agent, runs, client } = build({ responses: [response([text('Sure, doing it now.'), toolUse('tu_1', name, input)])] });
    const session = newSession();
    const turn = await agent.runTurn(session, 'send it please', WS, { language: 'en' });

    expect(runs[name]).not.toHaveBeenCalled();
    Object.values(runs).forEach((run) => expect(run).not.toHaveBeenCalled());
    expect(turn.pendingAction).toMatchObject({ toolName: name });
    expect(turn.pendingAction.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.pendingAction).toEqual(turn.pendingAction);
    expect(client.messages.create).toHaveBeenCalledTimes(1); // the turn ends at the proposal
  });

  test('the card is built from the arguments, never from what the model said', async () => {
    const lookups = F.makeLookups();
    const { agent } = build({
      lookups,
      responses: [response([text('I will send the "Eid Offer" promotion to everyone and it was already sent.'), sendPromotion()])],
    });
    const turn = await agent.runTurn(newSession(), 'ارسل العرض', WS, { language: 'en' });

    expect(turn.reply).toBe(turn.pendingAction.summary);
    expect(turn.reply).toContain('Summer Sale'); // the name behind promotionId, from the lookup
    expect(turn.reply).not.toContain('Eid Offer');
    expect(turn.reply).not.toMatch(/already sent/i);
    expect(turn.pendingAction.summary).toMatch(/2 customers/);
    expect(turn.modelNote).toMatch(/already sent/); // kept for the operator, never shown as the confirmation
    expect(lookups.promotion).toHaveBeenCalledWith(WS, IDS.promo);
  });

  test('two action blocks in one response: only the FIRST becomes pending, the other never runs', async () => {
    const { agent, runs } = build({
      responses: [response([toolUse('a1', 'send_loyalty_reminders', {}), toolUse('a2', 'refund_order', { orderId: IDS.order })])],
    });
    const turn = await agent.runTurn(newSession(), 'send reminders', WS, { language: 'en' });
    expect(turn.pendingAction.toolName).toBe('send_loyalty_reminders');
    expect(runs.refund_order).not.toHaveBeenCalled();
    expect(runs.send_loyalty_reminders).not.toHaveBeenCalled();
  });

  test('if the first action block is invalid, the second is NOT promoted: both get error results and the model is asked again', async () => {
    const { agent, client, runs } = build({
      responses: [
        response([toolUse('a1', 'send_promotion', { promotionId: 'nope', customerIds: [IDS.c1] }), toolUse('a2', 'refund_order', { orderId: IDS.order })]),
        response([text('Which promotion do you mean?')]),
      ],
    });
    const session = newSession();
    const turn = await agent.runTurn(session, 'send the promo', WS, { language: 'en' });

    expect(turn.pendingAction).toBeNull();
    expect(session.pendingAction).toBeNull();
    expect(turn.reply).toBe('Which promotion do you mean?');
    expect(runs.send_promotion).not.toHaveBeenCalled();
    expect(runs.refund_order).not.toHaveBeenCalled();
    const results = client.calls[1].body.messages.at(-1).content;
    expect(results.map((r) => [r.tool_use_id, r.is_error])).toEqual([['a1', true], ['a2', true]]);
    expect(results[0].content).toMatch(/promotionId must be a 24-character hex id/);
    expect(results[1].content).toMatch(/Only one action can be proposed/);
  });

  test('NoSQL operator bodies in model-produced ids are rejected before anything is stored', async () => {
    const attacks = [
      { promotionId: IDS.promo, customerIds: [{ $ne: null }] },
      { promotionId: { $gt: '' }, customerIds: [IDS.c1] },
      { promotionId: IDS.promo, customerIds: { $in: [IDS.c1] } },
      { promotionId: IDS.promo, customerIds: [IDS.c1, 'not-an-id'] },
    ];
    for (const input of attacks) {
      const { agent, runs, client } = build({
        responses: [response([toolUse('tu_x', 'send_promotion', input)]), response([text('I could not prepare that.')])],
      });
      const session = newSession();
      const turn = await agent.runTurn(session, 'send it', WS, { language: 'en' });
      expect(turn.pendingAction).toBeNull();
      expect(session.pendingAction).toBeNull();
      expect(runs.send_promotion).not.toHaveBeenCalled();
      const result = client.calls[1].body.messages.at(-1).content[0];
      expect(result).toMatchObject({ tool_use_id: 'tu_x', is_error: true });
      expect(result.content).toMatch(/invalid arguments/);
    }
  });

  test('an EMPTY customer list for loyalty reminders is rejected: it would otherwise mean "everyone with points"', async () => {
    const { agent, client } = build({
      responses: [response([toolUse('tu_1', 'send_loyalty_reminders', { customerIds: [] })]), response([text('Who should I remind?')])],
    });
    const turn = await agent.runTurn(newSession(), 'remind them', WS, { language: 'en' });
    expect(turn.pendingAction).toBeNull();
    expect(client.calls[1].body.messages.at(-1).content[0].content).toMatch(/at least one id/);
  });

  test('an action that points at a record the workspace does not have is not proposed', async () => {
    const lookups = F.makeLookups({ promotion: jest.fn(async () => null) });
    const { agent, client } = build({
      lookups,
      responses: [response([sendPromotion()]), response([text('I cannot find that promotion.')])],
    });
    const turn = await agent.runTurn(newSession(), 'send it', WS, { language: 'en' });
    expect(turn.pendingAction).toBeNull();
    expect(client.calls[1].body.messages.at(-1).content[0].content).toMatch(/does not match any promotion in this workspace/);
  });

  test('customers that do not exist in the workspace make the proposal fail', async () => {
    const lookups = F.makeLookups({ customers: jest.fn(async () => ({ found: 1, names: ['Sara'] })) });
    const { agent, client } = build({ lookups, responses: [response([sendPromotion()]), response([text('Let me look them up again.')])] });
    const turn = await agent.runTurn(newSession(), 'send it', WS, { language: 'en' });
    expect(turn.pendingAction).toBeNull();
    expect(client.calls[1].body.messages.at(-1).content[0].content).toMatch(/1 of the 2 customerIds do not match customers/);
  });

  test('refunding an order that is not paid is not proposed (it can never succeed)', async () => {
    const lookups = F.makeLookups({ order: jest.fn(async () => ({ total: 10, paymentStatus: 'pending', hasStripePayment: false })) });
    const { agent, client } = build({
      lookups,
      responses: [response([toolUse('tu_1', 'refund_order', { orderId: IDS.order })]), response([text('That order is unpaid.')])],
    });
    const turn = await agent.runTurn(newSession(), 'refund order', WS, { language: 'en' });
    expect(turn.pendingAction).toBeNull();
    expect(client.calls[1].body.messages.at(-1).content[0].content).toMatch(/only paid orders can be refunded/);
  });

  test('a response cut off by max_tokens that contains a tool call is never acted on', async () => {
    const { agent, runs } = build({
      responses: [response([text('Sending to all'), sendPromotion()], { stop_reason: 'max_tokens' })],
    });
    const session = newSession();
    const turn = await agent.runTurn(session, 'send to everyone', WS, { language: 'en' });
    expect(turn.pendingAction).toBeNull();
    expect(session.pendingAction).toBeNull();
    expect(turn.reply).toMatch(/too big/i);
    Object.values(runs).forEach((run) => expect(run).not.toHaveBeenCalled());
  });

  test('a new message supersedes the pending action: the old id can no longer be confirmed', async () => {
    const { agent, runs } = build({ responses: [response([sendPromotion()]), response([text('Fine, what else?')])] });
    const session = newSession();
    const first = await agent.runTurn(session, 'send it', WS, { language: 'en' });
    await agent.runTurn(session, 'actually, never mind', WS, { language: 'en' });
    expect(session.pendingAction).toBeNull();
    await expect(agent.confirmAction(session, first.pendingAction.id, true, WS)).rejects.toMatchObject({ status: 409, code: 'ACTION_NOT_PENDING' });
    expect(runs.send_promotion).not.toHaveBeenCalled();
  });

  test('a proposal whose request contained no recognisable ask carries a caution line; a clear ask does not', async () => {
    const make = () => build({ responses: [response([toolUse('tu_1', 'send_loyalty_reminders', {})])] });
    const question = await make().agent.runTurn(newSession(), 'كم عميل ما طلبوا من شهر؟', WS, { language: 'ar' });
    expect(question.pendingAction.summary).toMatch(/راجع التفاصيل جيداً قبل التأكيد/);
    const ask = await make().agent.runTurn(newSession(), 'أبغى أرسل تذكير للي عندهم نقاط', WS, { language: 'ar' });
    expect(ask.pendingAction.summary).not.toMatch(/راجع التفاصيل جيداً قبل التأكيد/);
    const affirm = await make().agent.runTurn(newSession(), 'تمام', WS, { language: 'ar' });
    expect(affirm.pendingAction.summary).not.toMatch(/راجع التفاصيل جيداً قبل التأكيد/);
    // Still only a proposal in every case: nothing auto-runs.
    expect(question.pendingAction).toBeTruthy();
  });
});

describe('confirming', () => {
  async function propose(opts = {}) {
    const ctx = build({ responses: [response([sendPromotion()])], ...opts });
    const session = newSession();
    const turn = await ctx.agent.runTurn(session, 'send the promo to them', WS, { language: 'en' });
    return { ...ctx, session, pending: turn.pendingAction };
  }

  test('runs the action exactly once, with the SERVER-stored arguments, after the id matches', async () => {
    const { agent, runs, session, pending } = await propose({ results: { send_promotion: { success: true, sentCount: 2, demoCount: 0 } } });
    expect(pending.args).toEqual({ promotionId: IDS.promo, customerIds: [IDS.c1, IDS.c2] });

    const out = await agent.confirmAction(session, pending.id, true, WS, { language: 'en' });

    expect(runs.send_promotion).toHaveBeenCalledTimes(1);
    expect(runs.send_promotion).toHaveBeenCalledWith({ promotionId: IDS.promo, customerIds: [IDS.c1, IDS.c2] }, WS);
    expect(out).toMatchObject({ pendingAction: null, executed: true });
    expect(out.reply).toMatch(/sent to 2 customers/);
    expect(session.pendingAction).toBeNull();
    expect(session.messages.at(-1)).toMatchObject({ role: 'assistant', text: out.reply });
  });

  test('stored arguments are what runs, even if the request tries to say otherwise', async () => {
    const { agent, runs, session, pending } = await propose();
    // confirmAction has no argument channel at all; the only inputs are session, id, decision, workspace.
    expect(agent.confirmAction.length).toBeLessThanOrEqual(5);
    await agent.confirmAction(session, pending.id, true, WS, { language: 'en', args: { promotionId: IDS.promo2, customerIds: [IDS.c3] } });
    expect(runs.send_promotion.mock.calls[0][0]).toEqual({ promotionId: IDS.promo, customerIds: [IDS.c1, IDS.c2] });
  });

  test('the workspace passed to the tool is the verified one', async () => {
    const { agent, runs, session, pending } = await propose();
    await agent.confirmAction(session, pending.id, true, WS);
    expect(runs.send_promotion.mock.calls[0][1]).toBe(WS);
  });

  test.each([
    ['an unknown id', 'not-the-real-id'],
    ['an empty id', ''],
    ['undefined', undefined],
    ['an operator object', { $ne: null }],
    ['a number', 7],
  ])('%s => 409 ACTION_NOT_PENDING and nothing runs', async (label, bad) => {
    const { agent, runs, session, pending } = await propose();
    await expect(agent.confirmAction(session, bad, true, WS)).rejects.toMatchObject({ status: 409, code: 'ACTION_NOT_PENDING' });
    expect(runs.send_promotion).not.toHaveBeenCalled();
    expect(session.pendingAction).toEqual(pending); // a wrong id does not consume the real one
  });

  test('replaying a confirmed id => 409 and a second send never happens', async () => {
    const { agent, runs, session, pending } = await propose();
    await agent.confirmAction(session, pending.id, true, WS);
    await expect(agent.confirmAction(session, pending.id, true, WS)).rejects.toMatchObject({ status: 409, code: 'ACTION_NOT_PENDING' });
    expect(runs.send_promotion).toHaveBeenCalledTimes(1);
  });

  test('confirming with nothing pending => 409', async () => {
    const { agent } = build();
    await expect(agent.confirmAction(newSession(), 'anything', true, WS)).rejects.toMatchObject({ status: 409, code: 'ACTION_NOT_PENDING' });
  });

  test('declining runs nothing, clears the action and answers in the right language', async () => {
    const en = await propose();
    const outEn = await en.agent.confirmAction(en.session, en.pending.id, false, WS, { language: 'en' });
    expect(outEn).toMatchObject({ pendingAction: null, executed: false });
    expect(outEn.reply).toBe("No problem, I won't do that.");
    expect(en.session.pendingAction).toBeNull();
    Object.values(en.runs).forEach((run) => expect(run).not.toHaveBeenCalled());

    const ar = await propose();
    const outAr = await ar.agent.confirmAction(ar.session, ar.pending.id, false, WS, { language: 'ar' });
    expect(outAr.reply).toBe('لا مشكلة، لن أنفّذ ذلك.');
    Object.values(ar.runs).forEach((run) => expect(run).not.toHaveBeenCalled());
    await expect(ar.agent.confirmAction(ar.session, ar.pending.id, true, WS)).rejects.toMatchObject({ status: 409 });
  });

  test('only a literal true confirms: truthy strings and numbers decline', async () => {
    for (const value of ['true', 1, 'yes', {}, null, undefined]) {
      const { agent, runs, session, pending } = await propose();
      const out = await agent.confirmAction(session, pending.id, value, WS, { language: 'en' });
      expect(out.executed).toBe(false);
      expect(runs.send_promotion).not.toHaveBeenCalled();
    }
  });

  test('the pending action is cleared BEFORE execution, and stays cleared when execution throws', async () => {
    const { agent, runs, session, pending, log } = await propose();
    let pendingDuringRun = 'unset';
    runs.send_promotion.mockImplementation(async () => {
      pendingDuringRun = session.pendingAction;
      throw new Error('Invalid API Key provided: sk_live_SECRET123');
    });

    const out = await agent.confirmAction(session, pending.id, true, WS, { language: 'en' });

    expect(pendingDuringRun).toBeNull();
    expect(session.pendingAction).toBeNull();
    expect(out.executed).toBe(false);
    expect(out.reply).toBe("That didn't work. Please check the details and try again."); // generic, no internal text
    expect(out.reply).not.toMatch(/sk_live|API Key/);
    expect(log.mock.calls.flat().join(' ')).not.toMatch(/SECRET123/); // not logged either
    await expect(agent.confirmAction(session, pending.id, true, WS)).rejects.toMatchObject({ status: 409 });
    expect(runs.send_promotion).toHaveBeenCalledTimes(1);
  });

  test('known failures are explained in the merchant language; unknown ones never leak', async () => {
    const { agent, runs, session, pending } = await propose();
    runs.send_promotion.mockRejectedValue(new Error('Promotion not found'));
    const out = await agent.confirmAction(session, pending.id, true, WS, { language: 'ar' });
    expect(out.reply).toBe('لم تنجح العملية: تعذّر العثور على هذا العرض الترويجي.');
  });

  test('the demo-simulation disclosure is shown in both languages (it was added after a real incident)', async () => {
    const result = { success: true, sentCount: 1, demoCount: 1 };
    const en = await propose({ results: { send_promotion: result } });
    const outEn = await en.agent.confirmAction(en.session, en.pending.id, true, WS, { language: 'en' });
    expect(outEn.reply).toMatch(/simulated/i);
    expect(outEn.reply).toMatch(/no real WhatsApp message was sent/i);
    expect(outEn.reply).not.toMatch(/was sent to 1 customer/); // never an unqualified success

    const ar = await propose({ results: { send_promotion: result } });
    const outAr = await ar.agent.confirmAction(ar.session, ar.pending.id, true, WS, { language: 'ar' });
    expect(outAr.reply).toContain('تمت المحاكاة فقط');
    expect(outAr.reply).toContain('لم تُرسل أي رسالة واتساب فعلية');
  });

  test('if the registry no longer has the stored tool, or its stored args are no longer valid, nothing runs', async () => {
    const a = await propose();
    a.session.pendingAction.toolName = 'send_everything';
    const outA = await a.agent.confirmAction(a.session, a.pending.id, true, WS, { language: 'en' });
    expect(outA.executed).toBe(false);
    Object.values(a.runs).forEach((run) => expect(run).not.toHaveBeenCalled());

    const b = await propose();
    b.session.pendingAction.args = { promotionId: 'zzz', customerIds: [IDS.c1] };
    const outB = await b.agent.confirmAction(b.session, b.pending.id, true, WS, { language: 'en' });
    expect(outB.executed).toBe(false);
    expect(b.runs.send_promotion).not.toHaveBeenCalled();

    const c = await propose();
    c.session.pendingAction.toolName = 'create_promotion'; // a real tool, but not a gated action: must not be runnable via confirm
    const outC = await c.agent.confirmAction(c.session, c.pending.id, true, WS, { language: 'en' });
    expect(outC.executed).toBe(false);
    expect(c.runs.create_promotion).not.toHaveBeenCalled();
  });

  test('a failure while WORDING the result never turns a completed action into a reported failure', async () => {
    const { agent, runs, session, pending, log } = await propose();
    runs.send_promotion.mockResolvedValue({
      get sentCount() { throw new Error('boom while reading'); },
    });
    const out = await agent.confirmAction(session, pending.id, true, WS, { language: 'en' });
    expect(out.executed).toBe(true);
    expect(out.reply).toBe('Done.');
    expect(log).toHaveBeenCalled();
  });
});

describe('executeAction: the single funnel', () => {
  test('refuses an action tool unless confirmed === true; read tools run without confirmation', async () => {
    const { agent } = build();
    const action = { name: 'send_promotion', isAction: true, run: jest.fn(async () => 'sent') };
    const read = { name: 'list_promotions', isAction: false, run: jest.fn(async () => 'rows') };

    for (const confirmed of [undefined, false, 'true', 1, null]) {
      await expect(agent.executeAction(action, {}, WS, { confirmed })).rejects.toMatchObject({ code: 'ACTION_NOT_CONFIRMED' });
    }
    await expect(agent.executeAction(action, {}, WS)).rejects.toMatchObject({ code: 'ACTION_NOT_CONFIRMED' });
    expect(action.run).not.toHaveBeenCalled();

    await expect(agent.executeAction(action, { a: 1 }, WS, { confirmed: true })).resolves.toBe('sent');
    expect(action.run).toHaveBeenCalledWith({ a: 1 }, WS);
    await expect(agent.executeAction(read, {}, WS)).resolves.toBe('rows');
    await expect(agent.executeAction(undefined, {}, WS)).rejects.toThrow('Unknown tool');
  });
});

describe('simultaneous confirms (double click, retry) with the session store: exactly one executes', () => {
  test('two confirms of the same action race: one wins, the other gets 409, the tool runs once', async () => {
    const sessions = F.createMemorySessionStore();
    const { agent, runs } = build({ sessions, responses: [response([sendPromotion()])] });
    const session = await sessions.findOrCreate('session-race-0001', WS);
    const turn = await agent.runTurn(session, 'send it', WS, { language: 'en' });
    await sessions.saveTurn({ sessionId: session.sessionId, workspaceId: WS, messages: session.messages, pendingAction: session.pendingAction });

    // Two requests each load their own copy of the stored session, like two HTTP requests would.
    const a = await sessions.find('session-race-0001', WS);
    const b = await sessions.find('session-race-0001', WS);
    const results = await Promise.allSettled([
      agent.confirmAction(a, turn.pendingAction.id, true, WS, { language: 'en' }),
      agent.confirmAction(b, turn.pendingAction.id, true, WS, { language: 'en' }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ status: 409, code: 'ACTION_NOT_PENDING' });
    expect(runs.send_promotion).toHaveBeenCalledTimes(1);
  });

  test('a confirm and a decline racing: exactly one of them wins', async () => {
    const sessions = F.createMemorySessionStore();
    const { agent, runs } = build({ sessions, responses: [response([sendPromotion()])] });
    const session = await sessions.findOrCreate('session-race-0002', WS);
    const turn = await agent.runTurn(session, 'send it', WS, { language: 'en' });
    await sessions.saveTurn({ sessionId: session.sessionId, workspaceId: WS, messages: session.messages, pendingAction: session.pendingAction });
    const a = await sessions.find('session-race-0002', WS);
    const b = await sessions.find('session-race-0002', WS);
    const results = await Promise.allSettled([
      agent.confirmAction(a, turn.pendingAction.id, true, WS),
      agent.confirmAction(b, turn.pendingAction.id, false, WS),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(runs.send_promotion.mock.calls.length).toBeLessThanOrEqual(1);
  });

  test("another workspace cannot see or claim the session's action", async () => {
    const sessions = F.createMemorySessionStore();
    const { agent, runs } = build({ sessions, responses: [response([sendPromotion()])] });
    const session = await sessions.findOrCreate('session-owner-0003', WS);
    const turn = await agent.runTurn(session, 'send it', WS, { language: 'en' });
    await sessions.saveTurn({ sessionId: session.sessionId, workspaceId: WS, messages: session.messages, pendingAction: session.pendingAction });

    expect(await sessions.find('session-owner-0003', OTHER_WS)).toBeNull();
    await expect(sessions.findOrCreate('session-owner-0003', OTHER_WS)).rejects.toMatchObject({ status: 404, code: 'SESSION_NOT_FOUND' });
    expect(await sessions.claimPendingAction({ sessionId: 'session-owner-0003', workspaceId: OTHER_WS, actionId: turn.pendingAction.id })).toBe(false);

    // Even holding the owner's session object, a confirm under the other workspace's claim fails the claim.
    const stolen = await sessions.find('session-owner-0003', WS);
    await expect(agent.confirmAction(stolen, turn.pendingAction.id, true, OTHER_WS)).rejects.toMatchObject({ status: 409 });
    expect(runs.send_promotion).not.toHaveBeenCalled();
  });
});
